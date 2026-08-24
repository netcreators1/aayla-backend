const admin = require('firebase-admin');
const Papa = require('papaparse');

// We use the same service account as the Aiosell integration
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('../pmshotel-a0426-firebase-adminsdk-fbsvc-082978dc82.json');
  }
} catch (e) {
  console.warn("Could not load Firebase Service Account. PMS Integration will fail if not deployed with FIREBASE_SERVICE_ACCOUNT env var.");
}

if (serviceAccount && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://my-shagun-pms-100-default-rtdb.firebaseio.com"
  });
}

const db = admin.apps.length ? admin.database() : null;

const PUBLIC_MENU_URL = "https://docs.google.com/spreadsheets/d/1t1fewWf5izb958lm16CCwrZYkYi3lM_bh2auilnuz_M/export?format=csv&gid=0";
const PUBLIC_LIQUOR_URL = "https://docs.google.com/spreadsheets/d/1t1fewWf5izb958lm16CCwrZYkYi3lM_bh2auilnuz_M/export?format=csv&gid=419553995";

let menuCache = null;
let lastFetch = 0;

async function fetchMenuPrices() {
  const now = Date.now();
  if (menuCache && now - lastFetch < 1000 * 60 * 60) {
    return menuCache; // cache for 1 hour
  }
  
  const prices = {};
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
    
    const foodRes = await fetch(PUBLIC_MENU_URL, { signal: controller.signal });
    const foodCsv = await foodRes.text();
    Papa.parse(foodCsv, {
      header: true,
      complete: (results) => {
        results.data.forEach(item => {
          const name = item['Item Name'] || item.ItemName;
          if (name && item.Price) {
            prices[name.trim().toLowerCase()] = Number(item.Price);
          }
        });
      }
    });

    const liquorRes = await fetch(PUBLIC_LIQUOR_URL, { signal: controller.signal });
    const liquorCsv = await liquorRes.text();
    Papa.parse(liquorCsv, {
      header: true,
      complete: (results) => {
        results.data.forEach(item => {
          const name = item['Item Name'] || item.ItemName;
          if (name && item.Price) {
            prices[name.trim().toLowerCase()] = Number(item.Price);
          }
        });
      }
    });
    
    clearTimeout(timeoutId);
    
    menuCache = prices;
    lastFetch = now;
  } catch (error) {
    console.error("Error fetching menu for pricing (likely timeout)", error.message);
    // If it fails, we just return the empty prices object (or the stale cache if we had one)
    if (menuCache) return menuCache;
  }
  
  return prices;
}

async function getGuestName(roomId) {
  if (!db || !roomId || roomId === "UNKNOWN") return "Guest";
  try {
    const resSnap = await db.ref("reservations").once("value");
    const resData = resSnap.val();
    if (resData) {
      // Find the reservation matching the roomId
      const reservations = Object.values(resData);
      // We assume the most recent reservation for this room is the active one
      // or we can look for specific statuses like "checked_in" if they exist.
      const activeRes = reservations.reverse().find(r => String(r.room) === String(roomId));
      
      if (activeRes && activeRes.guestName) {
        return activeRes.guestName;
      }
    }
  } catch (e) {
    console.error("Failed to fetch guest name from Firebase:", e);
  }
  return "Guest";
}

async function processIntent(intentText, roomId, guestName = "VoiceBot Guest") {
  if (!db) {
    console.error("Firebase not initialized. Cannot process intent.");
    return "I'm sorry, I am not connected to the hotel system right now.";
  }

  try {
    const intent = JSON.parse(intentText);
    
    if (intent.action === "order_food") {
      // Send Food & Liquor orders to the exact foodOrders path in the PMS
      const orderRef = db.ref(`foodOrders`).push();
      
      const menuPrices = await fetchMenuPrices();
      
      // The PMS expects `items` to be an object with qty, price, and type
      const formattedItems = {};
      let subTotal = 0;
      
      intent.items.forEach(item => {
        const capitalized = item.charAt(0).toUpperCase() + item.slice(1);
        const searchName = item.toLowerCase();
        
        // Find price from CSV (fallback to 0 if not found in menu)
        const itemPrice = menuPrices[searchName] || 0;
        
        formattedItems[capitalized] = {
          qty: 1,
          price: itemPrice,
          type: "food" // Assuming voice orders default to food tax bracket for simplicity, or we could look up type.
        };
        
        subTotal += itemPrice;
      });
      
      const cgst = subTotal * 0.025; 
      const sgst = subTotal * 0.025;
      const flatTax = 0; // We assume food for voice orders.
      const totalAmount = subTotal + cgst + sgst + flatTax;

      const payload = {
        room: roomId || "UNKNOWN",
        guestName: guestName,
        orderClass: "Room",
        orderType: "food",
        items: formattedItems,
        subTotal: subTotal,
        cgst: cgst,
        sgst: sgst,
        flatTax: flatTax,
        totalAmount: totalAmount,
        status: "new", // "new" triggers the PMS sound notification!
        timestamp: admin.database.ServerValue.TIMESTAMP,
        source: "VoiceBot Aayla"
      };

      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Firebase connection timed out. Check Database URL.")), 5000));
      await Promise.race([orderRef.set(payload), timeout]);

      const details = intent.items.join(" and ");
      const greeting = guestName !== "Guest" && guestName !== "VoiceBot Guest" ? `Thank you, ${guestName}. ` : "";
      return `${greeting}Your order for ${details} has been accepted and is currently being processed. It will be delivered to your room in approximately 15 minutes.`;
    } 
    else if (intent.action === "laundry") {
      const requestRef = db.ref("laundry").push();
      
      const formattedItems = {};
      const displayTask = intent.task.charAt(0).toUpperCase() + intent.task.slice(1);
      
      formattedItems[displayTask] = {
        qty: 1,
        price: 0
      };

      const payload = {
        room: roomId || "UNKNOWN",
        guestName: guestName,
        items: formattedItems,
        totalPieces: 1,
        totalAmount: 0,
        notes: "Requested via Voice Assistant",
        priority: "Normal",
        status: "pending", // lowercase p for Laundry
        timestamp: new Date().toISOString(),
        source: "VoiceBot Aayla"
      };

      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Firebase connection timed out.")), 5000));
      await Promise.race([requestRef.set(payload), timeout]);

      const greeting = guestName !== "Guest" && guestName !== "VoiceBot Guest" ? `Certainly, ${guestName}. ` : "";
      return `${greeting}I have notified the laundry team to ${intent.task}. They will be with you shortly.`;
    }
    
    else if (intent.action === "housekeeping") {
      const requestRef = db.ref("roomRequests").push(); // React dashboard listens to 'roomRequests'
      
      const displayTask = intent.task.charAt(0).toUpperCase() + intent.task.slice(1);
      
      const payload = {
        roomNumber: roomId || "UNKNOWN",
        guestName: guestName,
        requestType: displayTask,
        notes: "Requested via Voice Assistant",
        status: "Pending", // uppercase P for RoomRequests
        timestamp: new Date().toISOString()
      };

      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Firebase connection timed out.")), 5000));
      await Promise.race([requestRef.set(payload), timeout]);

      const greeting = guestName !== "Guest" && guestName !== "VoiceBot Guest" ? `Certainly, ${guestName}. ` : "";
      return `${greeting}I have notified the housekeeping staff to ${intent.task}. They will be with you shortly.`;
    }
    
    else if (intent.action === "get_revenue") {
      const todayDate = new Date().toISOString().split('T')[0];
      let totalRevenue = 0;
      
      // 1. Get Food Orders
      const foodSnap = await db.ref("foodOrders").once("value");
      const foodData = foodSnap.val() || {};
      Object.values(foodData).forEach(f => {
         let safeTime = f.timestamp;
         if (typeof f.timestamp === 'number') safeTime = new Date(f.timestamp).toISOString();
         if (String(safeTime || "").startsWith(todayDate)) {
             const amount = f.totalAmount ? parseFloat(f.totalAmount) : 0;
             const gst = (f.cgst ? parseFloat(f.cgst) : 0) + (f.sgst ? parseFloat(f.sgst) : 0);
             totalRevenue += (amount + gst);
         }
      });
      
      // 2. Get Laundry Orders
      const lndSnap = await db.ref("laundry").once("value");
      const lndData = lndSnap.val() || {};
      Object.values(lndData).forEach(l => {
         if (String(l.timestamp || "").startsWith(todayDate)) {
             const amount = l.totalAmount ? parseFloat(l.totalAmount) : 0;
             totalRevenue += (amount + (amount * 0.18));
         }
      });
      
      // 3. Get Room Reservations
      const resSnap = await db.ref("reservations").once("value");
      const resData = resSnap.val() || {};
      Object.values(resData).forEach(r => {
         const dateStr = r.timestamp || (r.checkIn ? new Date(r.checkIn).toISOString() : "");
         if (String(dateStr).startsWith(todayDate)) {
             const tariff = r.totalRoomTariff ? parseFloat(r.totalRoomTariff) : 0;
             const gst = r.gst ? parseFloat(r.gst) : 0;
             totalRevenue += (tariff + gst);
         }
      });
      
      return `The total revenue recorded so far for today is ${Math.round(totalRevenue)} rupees.`;
    }
    
    else if (intent.action === "iot_control") {
      const dev = (intent.device || "").toLowerCase();
      const st = (intent.state || "on").toLowerCase();
      
      if (dev.includes("ac") || dev.includes("air")) {
          // Legacy support: push to iot_commands for AC
          await db.ref("iot_commands").push({
             room: roomId || "UNKNOWN",
             type: "AC",
             action: st,
             timestamp: new Date().toISOString()
          });
      } else {
          // New architecture: sync to iot_state
          const safeDevice = dev.replace(/[^a-zA-Z0-9_]/g, '_');
          await db.ref(`iot_state/${roomId || "UNKNOWN"}/${safeDevice}`).set(st);
      }
      
      const greeting = guestName !== "Guest" && guestName !== "VoiceBot Guest" ? `Okay, ${guestName}, ` : "Okay, ";
      return `${greeting}I have turned ${st} the ${dev.replace('_', ' ')}.`;
    }

    else if (intent.action === "general_query") {
      return intent.response;
    }
    
    return "I'm sorry, I didn't quite catch that. Could you repeat?";
    
  } catch (error) {
    console.error("Error processing intent:", error);
    return "I'm sorry, I encountered an error while processing your request.";
  }
}

module.exports = { processIntent, getGuestName };

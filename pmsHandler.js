const admin = require('firebase-admin');

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
    databaseURL: "https://pmshotel-a0426-default-rtdb.firebaseio.com"
  });
}

const db = admin.apps.length ? admin.database() : null;

async function processIntent(intentText, roomId) {
  if (!db) {
    console.error("Firebase not initialized. Cannot process intent.");
    return "I'm sorry, I am not connected to the hotel system right now.";
  }

  try {
    const intent = JSON.parse(intentText);
    
    if (intent.action === "order_food") {
      const orderRef = db.ref(`pos/restaurant/orders`).push();
      await orderRef.set({
        roomId: roomId || "UNKNOWN",
        items: intent.items,
        status: "pending",
        timestamp: admin.database.ServerValue.TIMESTAMP,
        source: "VoiceBot Aayla"
      });
      return `I have placed an order for ${intent.items.join(", ")}. It will be delivered to your room shortly.`;
    } 
    
    else if (intent.action === "housekeeping") {
      const hkRef = db.ref(`housekeeping/requests`).push();
      await hkRef.set({
        roomId: roomId || "UNKNOWN",
        task: intent.task,
        status: "pending",
        timestamp: admin.database.ServerValue.TIMESTAMP,
        source: "VoiceBot Aayla"
      });
      return `I have notified housekeeping to ${intent.task}. They will be with you shortly.`;
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

module.exports = { processIntent };

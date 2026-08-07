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
      // Send Food & Liquor orders to the Food & Bar Menu under the specific Room ID
      const orderRef = db.ref(`Food & Bar Menu/${roomId || "UNKNOWN"}`).push();
      
      const details = intent.items.join(", ");
      await orderRef.set({
        items: details,
        status: "pending",
        timestamp: admin.database.ServerValue.TIMESTAMP,
        source: "VoiceBot Aayla"
      });

      return `I have placed an order for ${details}. It will be delivered to your room shortly.`;
    } 
    else if (intent.action === "housekeeping") {
      // Send Housekeeping requests to standard room_requests
      const requestRef = db.ref(`room_requests`).push();
      
      await requestRef.set({
        roomId: roomId || "UNKNOWN",
        type: "Housekeeping",
        details: intent.task,
        status: "pending",
        timestamp: admin.database.ServerValue.TIMESTAMP,
        source: "VoiceBot Aayla"
      });

      return `I have notified the staff to ${intent.task}. They will be with you shortly.`;
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

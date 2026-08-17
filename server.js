require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { processIntent, getGuestName } = require('./pmsHandler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Utility to create a WAV header for 16-bit, 16kHz, mono PCM
function createWavHeader(dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size
  header.writeUInt16LE(1, 20); // AudioFormat (PCM)
  header.writeUInt16LE(1, 22); // NumChannels
  header.writeUInt32LE(16000, 24); // SampleRate
  header.writeUInt32LE(16000 * 2, 28); // ByteRate
  header.writeUInt16LE(2, 32); // BlockAlign
  header.writeUInt16LE(16, 34); // BitsPerSample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

wss.on('connection', (ws) => {
  console.log('ESP32 Voice Bot connected!');
  let audioBuffer = [];
  let roomId = "UNKNOWN";

  ws.on('message', async (message, isBinary) => {
    if (!isBinary) {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'start') {
          console.log(`Started recording for Room: ${data.roomId}`);
          roomId = data.roomId;
          audioBuffer = [];
        } else if (data.type === 'stop') {
          console.log('Stopped recording, processing audio...');
          await processAudio(Buffer.concat(audioBuffer), ws, roomId);
        }
      } catch (e) {
        console.error("Invalid JSON command:", message.toString());
      }
    } else {
      // Append raw PCM data to buffer
      audioBuffer.push(message);
    }
  });

  ws.on('close', () => {
    console.log('ESP32 disconnected.');
  });
});

async function processAudio(pcmBuffer, ws, roomId) {
  try {
    ws.send(JSON.stringify({ type: "trace", message: `Received ${pcmBuffer.length} bytes of audio.` }));
    
    // 1. Create WAV file from PCM data in memory
    const wavHeader = createWavHeader(pcmBuffer.length);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
    
    // DEBUG: Save the audio to a file so we can listen to it!
    fs.writeFileSync('debug_audio.wav', wavBuffer);
    console.log('Saved audio to debug_audio.wav for testing!');
    
    ws.send(JSON.stringify({ type: "trace", message: "Calling Groq Whisper (Speech-to-Text)..." }));
    
    // 2. Speech-to-Text (Groq Whisper-large-v3)
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'en'); 
    formData.append('temperature', '0.0'); // Force deterministic output to prevent YouTube hallucinations on silence
    formData.append('prompt', 'A hotel guest is asking for room service or housekeeping. Examples: "Order coffee", "Pick up my laundry", "Clean my room", "I need fresh towels".');

    const whisperResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: formData
    });

    const whisperData = await whisperResponse.json();
    if (whisperData.error) throw new Error("Groq STT Failed: " + JSON.stringify(whisperData.error));
    
    const userText = whisperData.text.trim();
    ws.send(JSON.stringify({ type: 'trace', message: `Heard: "${userText}"` }));

    ws.send(JSON.stringify({ type: 'trace', message: 'Calling Groq Llama-3 for Intent...' }));

    const guestName = await getGuestName(roomId);
    ws.send(JSON.stringify({ type: 'trace', message: `Fetched Guest Name: ${guestName} for Room: ${roomId}` }));

    // 3. LLM Intent Parsing (Groq Llama-3)
    const prompt = `You are Aayla, a professional English-speaking hotel AI assistant.
    You are speaking with the guest: ${guestName} in room ${roomId}. If you know their name, address them naturally by name in your responses.
    Extract the intent from the guest's request.
    CRITICAL RULES:
    1. If the guest asks to turn ON or OFF a device like the AC, bedroom light, bed light, or TV, output "iot_control". (CRITICAL: Any request involving 'lights', 'AC', or 'turn on/off' is ALWAYS iot_control. NEVER classify these as food or housekeeping).
    2. If the guest asks for ANY food, drinks, or beverages, output "order_food".
    3. If the guest asks for room cleaning, fresh towels, amenities, or physical repairs, output "housekeeping".
    4. If the guest asks for laundry service, ironing, or washing clothes, output "laundry".
    5. If the user (hotel manager) asks for today's revenue, sales, or earnings, output "get_revenue".
    6. HALLUCINATION CHECK: If the guest's request contains EXACTLY "Thank you for watching", "subscribe", or talks about YouTube, you MUST output general_query with response: "I couldn't hear you clearly. Please check your microphone wires and try speaking closer to the mic." 
    7. For any other request, output "general_query" and answer their question naturally as Aayla.
    
    Respond with ONLY a JSON object in exactly one of these formats:
    - {"action": "order_food", "items": ["<noun1>", "<noun2>"]} (CRITICAL: Replace <noun> with the exact specific food/drink nouns the user asked for. NEVER use generic category names.)
    - {"action": "housekeeping", "task": "description of task"}
    - {"action": "laundry", "task": "description of laundry request"}
    - {"action": "iot_control", "device": "bedroom_light", "state": "on|off"}
    - {"action": "get_revenue"}
    - {"action": "general_query", "response": "Your spoken answer to their general question as Aayla."}
    
    Guest request: "${userText}"`;

    const llmResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "llama3-8b-8192",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      })
    });

    if (!llmResponse.ok) {
      const errText = await llmResponse.text();
      throw new Error(`Groq LLM Failed: ${llmResponse.status} - ${errText}`);
    }

    const llmData = await llmResponse.json();
    const intentJSON = llmData.choices[0].message.content;
    ws.send(JSON.stringify({ type: "trace", message: `Intent Parsed: ${intentJSON}` }));

    // 4. Update PMS (Firebase) and get response text
    ws.send(JSON.stringify({ type: "trace", message: "Updating Firebase..." }));
    const responseText = await processIntent(intentJSON, roomId, guestName);
    ws.send(JSON.stringify({ type: "trace", message: `Firebase Updated! Response: ${responseText}` }));

    // 5. Text-to-Speech (Deepgram - Free Tier, returns raw PCM)
    ws.send(JSON.stringify({ type: "trace", message: "Calling Deepgram TTS..." }));
    
    // Deepgram Aura Asteria (Female voice)
    const ttsResponse = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&container=none&sample_rate=24000', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: responseText
      })
    });

    if (!ttsResponse.ok) {
      const errText = await ttsResponse.text();
      throw new Error(`Deepgram TTS Failed: ${ttsResponse.status} - ${errText}`);
    }

    const pcmResponseData = Buffer.from(await ttsResponse.arrayBuffer());
    
    // SOFTWARE VOLUME BOOSTER (Increase Volume 1.25x)
    for (let i = 0; i < pcmResponseData.length - 1; i += 2) {
      let sample = pcmResponseData.readInt16LE(i);
      sample = Math.floor(sample * 1.25); // 1.25x Volume Multiplier (Safe bump without hard clipping)
      
      // Clamp to prevent audio distortion/clipping
      if (sample > 32767) sample = 32767;
      if (sample < -32768) sample = -32768;
      
      pcmResponseData.writeInt16LE(sample, i);
    }
  
    ws.send(JSON.stringify({ type: 'audio_start', size: pcmResponseData.length }));
    
    // Chunk the audio data so we don't crash the ESP32's tiny RAM!
    // 1024 bytes = 21.3ms of audio. 
    // Sending it every 10ms streams at 2x real-time (perfect balance to avoid underrun and overflow).
    const chunkSize = 1024;
    const delay = ms => new Promise(res => setTimeout(res, ms));
    
    for (let i = 0; i < pcmResponseData.length; i += chunkSize) {
      ws.send(pcmResponseData.slice(i, i + chunkSize));
      await delay(10);
    }
    
    // Tell the ESP32 we are done sending audio so it can go back to IDLE
    ws.send(JSON.stringify({ type: 'audio_end' }));
    
  } catch (error) {
    console.error("Error processing audio:", error);
    ws.send(JSON.stringify({ type: "error", message: error.message || "Unknown Server Error" }));
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Aayla Voice Bot server running on port ${PORT}`);
});

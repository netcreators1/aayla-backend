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

function createWavHeader(dataLength) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(16000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
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
        console.error("Invalid JSON:", message.toString());
      }
    } else {
      audioBuffer.push(message);
    }
  });
  ws.on('close', () => console.log('ESP32 disconnected.'));
});

async function processAudio(pcmBuffer, ws, roomId) {
  try {
    ws.send(JSON.stringify({ type: "trace", message: `Received ${pcmBuffer.length} bytes of audio.` }));
    const wavHeader = createWavHeader(pcmBuffer.length);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
    
    ws.send(JSON.stringify({ type: "trace", message: "Calling Groq Whisper..." }));
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'en'); 
    formData.append('temperature', '0.0');
    formData.append('prompt', 'A hotel guest is asking for room service or housekeeping.');

    const whisperResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData
    });

    const whisperData = await whisperResponse.json();
    if (whisperData.error) throw new Error("Groq STT Failed");
    const userText = whisperData.text.trim();
    ws.send(JSON.stringify({ type: 'trace', message: `Heard: "${userText}"` }));

    const guestName = await getGuestName(roomId);
    
    const prompt = `You are Aayla, a hotel AI. Guest: ${guestName}, Room: ${roomId}.
    Map the guest request to one of the following actions.
    Respond ONLY with a JSON object matching this schema:
    {
      "action": "order_food" | "housekeeping" | "laundry" | "get_revenue" | "iot_control" | "general_query",
      "items": ["coffee", "sandwich"], // list of items if order_food
      "task": "clean room", // if housekeeping or laundry
      "device": "AC", // if iot_control
      "state": "on", // if iot_control
      "response": "Answer to general query" // if general_query
    }
    Guest request: "${userText}"`;

    const llmResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      })
    });
    
    const intentJSON = (await llmResponse.json()).choices[0].message.content;
    ws.send(JSON.stringify({ type: "trace", message: `LLM Output: ${intentJSON}` }));
    
    const responseText = await processIntent(intentJSON, roomId, guestName);
    ws.send(JSON.stringify({ type: "trace", message: `Response: ${responseText}` }));

    ws.send(JSON.stringify({ type: "trace", message: "Calling Deepgram TTS (linear16)..." }));
    const ttsResponse = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=16000&container=none', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: responseText })
    });

    const rawPcm = Buffer.from(await ttsResponse.arrayBuffer()); // No WAV header to slice!

    ws.send(JSON.stringify({ type: 'audio_start', size: rawPcm.length }));
    const chunkSize = 1024;
    for (let i = 0; i < rawPcm.length; i += chunkSize) {
      ws.send(rawPcm.slice(i, i + chunkSize));
      await new Promise(r => setTimeout(r, 26)); // Pacing at ~26ms per 1024 bytes (slightly faster than real-time)
    }
    ws.send(JSON.stringify({ type: 'audio_end' }));

  } catch (error) {
    console.error(error);
    ws.send(JSON.stringify({ type: "trace", message: `Error: ${error.message}` }));
  }
}

server.listen(process.env.PORT || 3000, () => console.log('Backend running'));

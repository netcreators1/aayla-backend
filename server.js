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

// Serve the debug audio file
app.get('/debug', (req, res) => {
  const filePath = path.join(__dirname, 'debug_audio.wav');
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('Audio file not generated yet. Ask Aayla something first!');
  }
});

app.get('/test-sine', async (req, res) => {
  res.send("Generating 3-second sine wave and sending with ADVANCED PACING...");
  
  const sampleRate = 8000;
  const durationSec = 3;
  const freq = 440.0;
  const amplitude = 4000; 
  
  const totalSamples = sampleRate * durationSec;
  const pcmResponseData = Buffer.alloc(totalSamples * 2);
  
  for (let i = 0; i < totalSamples; i++) {
    let sample = Math.floor(amplitude * Math.sin(2.0 * Math.PI * freq * i / sampleRate));
    pcmResponseData.writeInt16LE(sample, i * 2);
  }
  
  let paddedLength = pcmResponseData.length;
  if (paddedLength % 4 !== 0) {
    paddedLength += (4 - (paddedLength % 4));
  }
  const finalAudioBuffer = Buffer.alloc(paddedLength);
  pcmResponseData.copy(finalAudioBuffer);
  
  wss.clients.forEach(async (ws) => {
      ws.send(JSON.stringify({ type: "audio_start", size: finalAudioBuffer.length }));
      
      const chunkSize = 1024;
      // Prefill 15 chunks (15KB = 312ms of audio) instantly to absorb network jitter
      const prefillChunks = 5;
      let i = 0;
      
      for (; i < finalAudioBuffer.length && i < prefillChunks * chunkSize; i += chunkSize) {
        ws.send(finalAudioBuffer.slice(i, i + chunkSize));
      }
      
      const startTime = Date.now();
      // 1024 bytes of 24kHz Mono = 21.33ms. We pace at 19.5ms to send slightly FASTER than real-time,
      // which guarantees the buffer stays full without hitting TCP Zero Window!
      const pacingMs = 64.0; 
      let pacedChunkIndex = prefillChunks; 
      
      for (; i < finalAudioBuffer.length; i += chunkSize) {
        ws.send(finalAudioBuffer.slice(i, i + chunkSize));
        pacedChunkIndex++;
        
        const expectedTime = startTime + (pacedChunkIndex * pacingMs);
        const waitTime = expectedTime - Date.now();
        if (waitTime > 0) {
          await new Promise(r => setTimeout(r, waitTime));
        }
      }
      
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "audio_end" }));
      }, 1000);
  });
});

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
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
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
    const ttsResponse = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&container=none&sample_rate=8000', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: responseText })
    });

    if (!ttsResponse.ok) {
      console.error("Deepgram TTS Error:", await ttsResponse.text());
      return;
    }

    let pcmResponseData = Buffer.from(await ttsResponse.arrayBuffer());
    
    let optimalMultiplier = 0.3;

    for (let i = 0; i < pcmResponseData.length - 1; i += 2) {
      let sample = pcmResponseData.readInt16LE(i);
      sample = Math.floor(sample * optimalMultiplier);
      if (sample > 32767) sample = 32767;
      if (sample < -32768) sample = -32768;
      pcmResponseData.writeInt16LE(sample, i);
    }
    
    // The ESP32 I2S hardware DMA is 32-bit (4 bytes). We must pad to a multiple of 4.
    let paddedLength = pcmResponseData.length;
    if (paddedLength % 4 !== 0) {
      paddedLength += (4 - (paddedLength % 4));
    }
    const finalAudioBuffer = Buffer.alloc(paddedLength);
    pcmResponseData.copy(finalAudioBuffer);
    
    // SERVER-SIDE AUDIO DIAGNOSTIC DUMP
    const debugWavHeader = Buffer.alloc(44);
    debugWavHeader.write('RIFF', 0);
    debugWavHeader.writeUInt32LE(36 + finalAudioBuffer.length, 4);
    debugWavHeader.write('WAVE', 8);
    debugWavHeader.write('fmt ', 12);
    debugWavHeader.writeUInt32LE(16, 16); 
    debugWavHeader.writeUInt16LE(1, 20); 
    debugWavHeader.writeUInt16LE(1, 22); 
    debugWavHeader.writeUInt32LE(16000, 24); 
    debugWavHeader.writeUInt32LE(8000 * 1 * 2, 28); 
    debugWavHeader.writeUInt16LE(1 * 2, 32); 
    debugWavHeader.writeUInt16LE(16, 34); 
    debugWavHeader.write('data', 36);
    debugWavHeader.writeUInt32LE(finalAudioBuffer.length, 40);
    
    fs.writeFileSync('debug_audio.wav', debugWavHeader);
    fs.appendFileSync('debug_audio.wav', finalAudioBuffer);
    ws.send(JSON.stringify({ type: 'trace', message: `Saved debug_audio.wav to server folder!` }));
  
    ws.send(JSON.stringify({ type: 'audio_start', size: finalAudioBuffer.length }));
    
    const chunkSize = 1024;
    const prefillChunks = 5; // 312ms shock absorption
    let i = 0;
    
    for (; i < finalAudioBuffer.length && i < prefillChunks * chunkSize; i += chunkSize) {
      ws.send(finalAudioBuffer.slice(i, i + chunkSize));
    }
    
    const startTime = Date.now();
    // 1024 bytes of 24kHz Mono = 21.33ms. Pace at 19.5ms (faster than real-time)
    const pacingMs = 64.0; 
    let pacedChunkIndex = prefillChunks; 
    
    for (; i < finalAudioBuffer.length; i += chunkSize) {
      ws.send(finalAudioBuffer.slice(i, i + chunkSize));
      pacedChunkIndex++;
      
      const expectedTime = startTime + (pacedChunkIndex * pacingMs);
      const waitTime = expectedTime - Date.now();
      if (waitTime > 0) {
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
    
    const durationMs = (finalAudioBuffer.length / 2 / 8000) * 1000;
    setTimeout(() => {
        ws.send(JSON.stringify({ type: 'audio_end' }));
    }, durationMs + 1000);

  } catch (error) {
    console.error("Error processing audio:", error);
    ws.send(JSON.stringify({ type: "trace", message: `Error processing audio: ${error.message}` }));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Aayla Voice Backend running on port ${PORT}`);
});



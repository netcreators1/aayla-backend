require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { processIntent } = require('./pmsHandler');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    
    // 1. Create WAV file from PCM data
    const wavHeader = createWavHeader(pcmBuffer.length);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
    
    const tempFilePath = path.join(__dirname, `temp_${Date.now()}.wav`);
    fs.writeFileSync(tempFilePath, wavBuffer);

    ws.send(JSON.stringify({ type: "trace", message: "Calling OpenAI Whisper (Speech-to-Text)..." }));
    
    // 2. Speech-to-Text (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-1",
    });
    
    const userText = transcription.text;
    fs.unlinkSync(tempFilePath); // Cleanup

    ws.send(JSON.stringify({ type: "trace", message: `Heard: "${userText}"` }));

    if (!userText || userText.trim() === "") {
        ws.send(JSON.stringify({ type: "error", message: "No speech detected" }));
        return;
    }

    ws.send(JSON.stringify({ type: "trace", message: "Calling GPT-4o for Intent..." }));
    
    // 3. LLM Intent Parsing
    const prompt = `You are Aayla, an AI voice assistant for a hotel room.
    Extract the intent from the guest's request.
    Respond with ONLY a JSON object in one of these formats:
    - {"action": "order_food", "items": ["item1", "item2"]}
    - {"action": "housekeeping", "task": "description of task"}
    - {"action": "general_query", "response": "Your spoken answer to their general question as Aayla."}
    
    Guest request: "${userText}"`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    });

    const intentJSON = completion.choices[0].message.content;
    ws.send(JSON.stringify({ type: "trace", message: `Intent Parsed: ${intentJSON}` }));

    // 4. Update PMS (Firebase) and get response text
    ws.send(JSON.stringify({ type: "trace", message: "Updating Firebase..." }));
    const responseText = await processIntent(intentJSON, roomId);
    ws.send(JSON.stringify({ type: "trace", message: `Firebase Updated! Response: ${responseText}` }));

    // 5. Text-to-Speech
    ws.send(JSON.stringify({ type: "trace", message: "Calling OpenAI TTS..." }));
    const mp3Response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: responseText,
      response_format: "pcm"
    });

    const pcmResponseData = Buffer.from(await mp3Response.arrayBuffer());
    ws.send(JSON.stringify({ type: 'audio_start', size: pcmResponseData.length }));
    ws.send(pcmResponseData);
    
  } catch (error) {
    console.error("Error processing audio:", error);
    ws.send(JSON.stringify({ type: "error", message: error.message || "Unknown Server Error" }));
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Aayla Voice Bot server running on port ${PORT}`);
});

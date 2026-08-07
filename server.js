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
    // 1. Create WAV file from PCM data
    const wavHeader = createWavHeader(pcmBuffer.length);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
    
    // Create a temporary file to send to OpenAI
    const tempFilePath = path.join(__dirname, `temp_${Date.now()}.wav`);
    fs.writeFileSync(tempFilePath, wavBuffer);

    console.log('Transcribing audio...');
    // 2. Speech-to-Text (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: "whisper-1",
    });
    
    const userText = transcription.text;
    console.log(`Transcribed text: "${userText}"`);
    fs.unlinkSync(tempFilePath); // Cleanup

    if (!userText || userText.trim() === "") {
        ws.send(JSON.stringify({ type: "error", message: "No speech detected" }));
        return;
    }

    console.log('Determining intent...');
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
    console.log("Intent Parsed:", intentJSON);

    // 4. Update PMS (Firebase) and get response text
    const responseText = await processIntent(intentJSON, roomId);
    console.log(`Response text: "${responseText}"`);

    // 5. Text-to-Speech
    console.log('Generating audio response...');
    const mp3Response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova", // Female voice for Aayla
      input: responseText,
      response_format: "pcm" // Ask for raw PCM back! 24kHz 16-bit mono.
    });

    const pcmResponseData = Buffer.from(await mp3Response.arrayBuffer());
    
    // We send a JSON metadata packet first, followed by the raw PCM data
    ws.send(JSON.stringify({ type: 'audio_start', size: pcmResponseData.length }));
    
    // Send raw PCM data to ESP32 for I2S playback
    // Since OpenAI returns 24kHz PCM, the ESP32 must configure its I2S playback to 24000Hz.
    // Or we could downsample to 16kHz here, but it's easier to change I2S freq on ESP32 dynamically.
    ws.send(pcmResponseData);
    
    console.log("Audio response sent back to ESP32.");

  } catch (error) {
    console.error("Error processing audio:", error);
    ws.send(JSON.stringify({ type: "error", message: "Server error" }));
  }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Aayla Voice Bot server running on port ${PORT}`);
});

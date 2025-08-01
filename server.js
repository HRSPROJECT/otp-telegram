const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// In-memory storage
const otpStorage = new Map();
const userSessions = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Direct API approach - no bot library
app.post('/generate-otp', async (req, res) => {
  const { chatId, username } = req.body;
  
  try {
    const otp = generateOTP();
    const timestamp = Date.now();
    
    // Store OTP
    otpStorage.set(parseInt(chatId), {
      otp: otp,
      username: username,
      timestamp: timestamp
    });
    
    // Send via Telegram API directly
    const message = `🔐 Your OTP: ${otp}\n⏰ Valid for 10 minutes`;
    
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: message
    });
    
    console.log(`✅ OTP ${otp} sent to ${username} (${chatId})`);
    res.json({ success: true, otp: otp });
    
  } catch (error) {
    console.error('❌ Error sending OTP:', error.message);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Get bot info and set commands
app.get('/setup-bot', async (req, res) => {
  try {
    // Get bot info
    const botInfo = await axios.get(`${TELEGRAM_API}/getMe`);
    
    // Set bot commands
    await axios.post(`${TELEGRAM_API}/setMyCommands`, {
      commands: [
        { command: 'start', description: 'Get OTP code' }
      ]
    });
    
    res.json({ 
      botInfo: botInfo.data,
      message: 'Bot setup complete'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle Telegram updates via webhook
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  const update = req.body;
  
  if (update.message && update.message.text === '/start') {
    const chatId = update.message.chat.id;
    const username = update.message.from.username || update.message.from.first_name || `user_${chatId}`;
    
    try {
      const otp = generateOTP();
      const timestamp = Date.now();
      
      // Store OTP
      otpStorage.set(chatId, {
        otp: otp,
        username: username,
        timestamp: timestamp
      });
      
      // Send OTP
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: `🔐 Your OTP: ${otp}\n⏰ Valid for 10 minutes`
      });
      
      console.log(`✅ OTP ${otp} sent to ${username} (${chatId})`);
      
    } catch (error) {
      console.error('❌ Error in webhook:', error.message);
    }
  }
  
  res.sendStatus(200);
});

// Set webhook
app.get('/set-webhook', async (req, res) => {
  const webhookUrl = `https://${req.get('host')}/webhook/${BOT_TOKEN}`;
  
  try {
    const response = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: webhookUrl
    });
    
    res.json({
      success: true,
      webhookUrl: webhookUrl,
      response: response.data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify OTP (same as before)
app.post('/api/verify-otp', (req, res) => {
  const { username, otp } = req.body;
  
  if (!username || !otp) {
    return res.status(400).json({ error: 'Username and OTP are required' });
  }
  
  let foundChatId = null;
  let foundUserData = null;
  
  for (const [chatId, userData] of otpStorage.entries()) {
    if (userData.username.toLowerCase() === username.toLowerCase() && userData.otp === otp) {
      const isExpired = (Date.now() - userData.timestamp) > 10 * 60 * 1000;
      
      if (isExpired) {
        otpStorage.delete(chatId);
        return res.status(400).json({ error: 'OTP has expired' });
      }
      
      foundChatId = chatId;
      foundUserData = userData;
      break;
    }
  }
  
  if (!foundChatId) {
    return res.status(400).json({ error: 'Invalid username or OTP' });
  }
  
  const sessionId = generateSessionId();
  userSessions.set(sessionId, {
    chatId: foundChatId,
    username: foundUserData.username,
    verified: true,
    timestamp: Date.now()
  });
  
  otpStorage.delete(foundChatId);
  
  // Send success message
  axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: foundChatId,
    text: `✅ Successfully verified! Welcome ${foundUserData.username}!`
  }).catch(console.error);
  
  res.json({
    success: true,
    sessionId: sessionId,
    username: foundUserData.username,
    message: 'OTP verified successfully'
  });
});

// Debug endpoints
app.get('/api/debug/otps', (req, res) => {
  const otps = [];
  for (const [chatId, data] of otpStorage.entries()) {
    otps.push({
      chatId,
      username: data.username,
      otp: data.otp,
      timestamp: data.timestamp,
      expired: (Date.now() - data.timestamp) > 10 * 60 * 1000
    });
  }
  res.json(otps);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeOTPs: otpStorage.size
  });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`🤖 Bot token: ${BOT_TOKEN ? 'Set' : 'Missing'}`);
});

module.exports = app;

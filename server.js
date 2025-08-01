const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Telegram Bot setup
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Add your bot token

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required!');
  process.exit(1);
}

// Use webhook for Vercel (faster than polling)
const bot = new TelegramBot(BOT_TOKEN, { 
  webHook: {
    port: process.env.PORT || 3000
  }
});

// Set webhook URL (replace with your Vercel URL)
const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://${process.env.VERCEL_URL}`;
if (WEBHOOK_URL && WEBHOOK_URL !== 'https://undefined') {
  bot.setWebHook(`${WEBHOOK_URL}/bot${BOT_TOKEN}`);
  console.log(`Webhook set to: ${WEBHOOK_URL}/bot${BOT_TOKEN}`);
} else {
  console.log('No webhook URL set, using polling for local development');
  bot.startPolling();
}

// In-memory storage (use database in production)
const otpStorage = new Map(); // chatId -> { otp, username, timestamp }
const userSessions = new Map(); // sessionId -> { chatId, username, verified }

// Generate random OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Generate session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Telegram Bot handlers
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || `user_${chatId}`;
  const startTime = Date.now();
  
  try {
    // Generate OTP immediately
    const otp = generateOTP();
    const timestamp = Date.now();
    
    // Store OTP with timestamp (expires in 10 minutes)
    otpStorage.set(chatId, {
      otp: otp,
      username: username,
      timestamp: timestamp
    });
    
    // Send OTP to user with minimal formatting for speed
    const message = `🔐 OTP: *${otp}*\n⏰ Expires in 10 minutes\n🌐 Use on verification form`;
    
    // Send message with error handling
    const sendResult = await bot.sendMessage(chatId, message, { 
      parse_mode: 'Markdown',
      disable_notification: false
    });
    
    const endTime = Date.now();
    console.log(`✅ OTP ${otp} sent to ${username} (${chatId}) in ${endTime - startTime}ms`);
    
  } catch (error) {
    console.error('❌ Error in /start handler:', error);
    
    // Fallback: send simple text message
    try {
      await bot.sendMessage(chatId, `Your OTP is: ${otp}\nExpires in 10 minutes.`);
    } catch (fallbackError) {
      console.error('❌ Fallback message also failed:', fallbackError);
    }
  }
});

// Handle any text message as potential /start
bot.on('message', async (msg) => {
  if (msg.text && msg.text.toLowerCase().includes('start')) {
    // Trigger start handler
    bot.emit('text', msg, [msg.text, 'start']);
  }
});

// Add error handling for bot
bot.on('error', (error) => {
  console.error('❌ Telegram Bot Error:', error);
});

bot.on('polling_error', (error) => {
  console.error('❌ Polling Error:', error);
});

bot.on('webhook_error', (error) => {
  console.error('❌ Webhook Error:', error);
});

// API Routes

// Webhook handler for Telegram
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Get user info by chat ID (for testing)
app.get('/api/user/:chatId', (req, res) => {
  const chatId = parseInt(req.params.chatId);
  const userData = otpStorage.get(chatId);
  
  if (!userData) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    username: userData.username,
    hasOTP: !!userData.otp,
    timestamp: userData.timestamp
  });
});

// Verify OTP
app.post('/api/verify-otp', (req, res) => {
  const { username, otp } = req.body;
  
  if (!username || !otp) {
    return res.status(400).json({ error: 'Username and OTP are required' });
  }
  
  // Find user by username and OTP
  let foundChatId = null;
  let foundUserData = null;
  
  for (const [chatId, userData] of otpStorage.entries()) {
    if (userData.username.toLowerCase() === username.toLowerCase() && userData.otp === otp) {
      // Check if OTP is not expired (10 minutes)
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
  
  // Create session
  const sessionId = generateSessionId();
  userSessions.set(sessionId, {
    chatId: foundChatId,
    username: foundUserData.username,
    verified: true,
    timestamp: Date.now()
  });
  
  // Remove used OTP
  otpStorage.delete(foundChatId);
  
  // Send success message to Telegram
  bot.sendMessage(foundChatId, `✅ Successfully verified! Welcome ${foundUserData.username}!`);
  
  res.json({
    success: true,
    sessionId: sessionId,
    username: foundUserData.username,
    message: 'OTP verified successfully'
  });
});

// Check session status
app.get('/api/session/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = userSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    username: session.username,
    verified: session.verified,
    timestamp: session.timestamp
  });
});

// Get all active OTPs (for debugging)
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

// Clean expired OTPs (run every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [chatId, data] of otpStorage.entries()) {
    if (now - data.timestamp > 10 * 60 * 1000) {
      otpStorage.delete(chatId);
      console.log(`Expired OTP removed for chat ${chatId}`);
    }
  }
}, 5 * 60 * 1000);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Make sure to set TELEGRAM_BOT_TOKEN environment variable`);
});

module.exports = app;

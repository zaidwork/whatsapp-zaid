import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

import db from './db.js';
import authRouter from './routes/auth.js';
import chatRouter from './routes/chat.js';

dotenv.config();

const app = express();
const server = http.createServer(app);

// إعداد CORS للسماح بالواجهة الأمامية بالاتصال
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

app.use(express.json());

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// مسارات الـ REST API
app.use('/api/auth', authRouter);
app.use('/api/chat', chatRouter);

import fs from 'fs';

// مسار فحص حالة السيرفر
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

const distPath = path.join(__dirname, '../frontend/dist');

if (fs.existsSync(distPath)) {
  // استضافة ملفات الفرونت اند المبنية استاتيكياً (في وضع التشغيل المحلي المدمج)
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  // في وضع التشغيل المنفصل أونلاين (مثل الاستضافة على Render)
  app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'WhatsApp E2EE Backend Server is running.' });
  });
}

// اختبار الاتصال بقاعدة البيانات عند بدء التشغيل
async function testDbConnection() {
  try {
    const result = await db.execute('SELECT 1');
    console.log('✅ تم الاتصال بقاعدة بيانات Turso السحابية بنجاح!');
    
    // التعديل التلقائي لجدول التشفير لإضافة العمود الجديد إن لم يكن موجوداً
    try {
      await db.execute("ALTER TABLE user_encryption_keys ADD COLUMN encrypted_private_key TEXT");
      console.log("✅ تمت إضافة عمود encrypted_private_key لجدول التشفير بنجاح!");
    } catch (alterErr) {
      if (alterErr.message.includes("duplicate column name") || alterErr.message.includes("already exists")) {
        console.log("ℹ️ عمود encrypted_private_key موجود مسبقاً في قاعدة البيانات.");
      } else {
        console.warn("⚠️ تنبيه أثناء تعديل الجدول (ربما العمود موجود):", alterErr.message);
      }
    }
  } catch (err) {
    console.error('❌ فشل الاتصال بقاعدة بيانات Turso. يرجى التحقق من الرابط والتوكن:', err.message);
  }
}
testDbConnection();

// إعداد Socket.io للمحادثة الفورية والمكالمات وحالة التواجد
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// تخزين الاتصالات النشطة (userId -> socketId)
const activeConnections = new Map();

// تخزين المكالمات النشطة لتتبع الحالات والمدة وسجل المكالمات
const activeCalls = new Map();

// دالة لمعالجة انتهاء المكالمة وحفظ سجلها في قاعدة البيانات
async function handleCallTermination(endedByUserId) {
  const callObj = activeCalls.get(endedByUserId);
  if (!callObj) return;

  // إزالة المكالمة لمنع الحفظ المكرر
  activeCalls.delete(callObj.callerId);
  activeCalls.delete(callObj.receiverId);

  let durationStr = '';
  let callStatus = 'ended'; // ended, missed, rejected

  if (callObj.status === 'ringing') {
    if (endedByUserId === callObj.receiverId) {
      callStatus = 'rejected';
    } else {
      callStatus = 'missed';
    }
  } else if (callObj.status === 'active' && callObj.answeredAt) {
    const durationSec = Math.round((Date.now() - callObj.answeredAt) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    durationStr = mins > 0 ? `${mins} دقيقة و ${secs} ثانية` : `${secs} ثانية`;
    callStatus = 'ended';
  }

  let messageText = '';
  if (callStatus === 'missed') {
    messageText = callObj.callType === 'video' ? '📹 مكالمة فيديو فائتة' : '📞 مكالمة صوتية فائتة';
  } else if (callStatus === 'rejected') {
    messageText = callObj.callType === 'video' ? '📹 مكالمة فيديو لم يتم الرد عليها' : '📞 مكالمة صوتية لم يتم الرد عليها';
  } else {
    const callTypeStr = callObj.callType === 'video' ? 'فيديو' : 'صوتية';
    messageText = `📞 مكالمة ${callTypeStr} صادرة (${durationStr})`;
  }

  const msgId = uuidv4();
  try {
    await db.execute({
      sql: `INSERT INTO messages (id, conversation_id, sender_id, encrypted_content, encryption_iv, message_type, status) 
            VALUES (?, ?, ?, ?, 'system', 'call_log', 'sent')`,
      args: [msgId, callObj.conversationId, callObj.callerId, messageText]
    });

    const callLogPayload = {
      id: msgId,
      conversation_id: callObj.conversationId,
      sender_id: callObj.callerId,
      encrypted_content: messageText,
      encryption_iv: 'system',
      message_type: 'call_log',
      status: 'sent',
      created_at: new Date().toISOString()
    };

    // إرسال رسالة السجل الجديدة لكلا المستخدمين لتحديث قائمة المحادثات والرسائل
    const callerSocketId = activeConnections.get(callObj.callerId);
    const receiverSocketId = activeConnections.get(callObj.receiverId);
    if (callerSocketId) io.to(callerSocketId).emit('new_message', callLogPayload);
    if (receiverSocketId) io.to(receiverSocketId).emit('new_message', callLogPayload);
  } catch (dbErr) {
    console.error('Error saving call log to database:', dbErr);
  }
}

// Middleware للتحقق من هوية المستخدم في الـ WebSockets
io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  
  if (!token) {
    return next(new Error('Authentication error: Token is required'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'whatsapp_clone_default_secret_key');
    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error('Authentication error: Invalid token'));
  }
});

// إدارة اتصالات WebSockets
io.on('connection', async (socket) => {
  const userId = socket.user.id;
  const username = socket.user.name;
  
  console.log(`🔌 مستخدم متصل: ${username} (${userId}) | Socket ID: ${socket.id}`);
  
  // تحديث الخريطة وجعل المستخدم أونلاين
  activeConnections.set(userId, socket.id);
  
  try {
    await db.execute({
      sql: 'UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
      args: [userId]
    });
    
    // إبلاغ جهات الاتصال أن المستخدم أصبح متصلاً (Online)
    broadcastPresence(userId, true);
  } catch (err) {
    console.error('Error updating presence online:', err);
  }

  // 1. إرسال واستلام الرسائل الفورية المشفرة
  socket.on('send_message', async (data, callback) => {
    const { conversation_id, receiver_id, encrypted_content, encryption_iv, message_type } = data;
    
    if (!conversation_id || !receiver_id || !encrypted_content || !encryption_iv) {
      if (callback) callback({ error: 'بيانات الرسالة غير مكتملة.' });
      return;
    }

    try {
      const messageId = uuidv4();
      const receiverSocketId = activeConnections.get(receiver_id);
      const initialStatus = receiverSocketId ? 'delivered' : 'sent';
      
      // حفظ الرسالة المشفرة بقاعدة بيانات Turso بالوضع الابتدائي المناسب مباشرة في استعلام واحد لتسريع العملية
      await db.execute({
        sql: `INSERT INTO messages (id, conversation_id, sender_id, encrypted_content, encryption_iv, message_type, status) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [messageId, conversation_id, userId, encrypted_content, encryption_iv, message_type || 'text', initialStatus]
      });

      const messagePayload = {
        id: messageId,
        conversation_id,
        sender_id: userId,
        encrypted_content,
        encryption_iv,
        message_type: message_type || 'text',
        status: initialStatus,
        created_at: new Date().toISOString()
      };

      // إذا كان المستقبل متصلاً، أرسل الرسالة له فوراً
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('new_message', messagePayload);
      }

      // إشعار مرسل الرسالة بنجاح الإرسال وتأكيد الحفظ
      if (callback) callback({ success: true, message: messagePayload });
    } catch (err) {
      console.error('Error saving/sending message:', err);
      if (callback) callback({ error: 'فشل إرسال الرسالة.' });
    }
  });

  // 2. تحديثات حالة الكتابة (Typing Indicator)
  socket.on('typing_status', (data) => {
    const { conversation_id, receiver_id, is_typing } = data;
    const receiverSocketId = activeConnections.get(receiver_id);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('typing_status', {
        conversation_id,
        sender_id: userId,
        is_typing
      });
    }
  });

  // 3. إشارات المكالمات (WebRTC Calling Signals)
  // بدء مكالمة جديدة
  socket.on('call_user', (data) => {
    const { receiver_id, offer, call_type, conversation_id } = data;

    // تسجيل المكالمة في الذاكرة لتتبعها وحفظ سجل المكالمات لاحقاً
    const callId = uuidv4();
    const callObj = {
      id: callId,
      callerId: userId,
      receiverId: receiver_id,
      callType: call_type,
      conversationId: conversation_id,
      status: 'ringing',
      startedAt: Date.now()
    };
    activeCalls.set(userId, callObj);
    activeCalls.set(receiver_id, callObj);

    const receiverSocketId = activeConnections.get(receiver_id);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('incoming_call', {
        caller_id: userId,
        caller_name: username,
        offer,
        call_type,
        conversation_id
      });
    }
  });

  // قبول المكالمة
  socket.on('answer_call', (data) => {
    const { caller_id, answer } = data;

    // تحديث حالة المكالمة النشطة في الذاكرة لتسجيل وقت البدء
    const callObj = activeCalls.get(userId);
    if (callObj) {
      callObj.status = 'active';
      callObj.answeredAt = Date.now();
    }

    const callerSocketId = activeConnections.get(caller_id);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call_answered', {
        receiver_id: userId,
        answer
      });
    }
  });

  // تبادل مرشحي الاتصال (ICE Candidates)
  socket.on('ice_candidate', (data) => {
    const { target_id, candidate } = data;
    const targetSocketId = activeConnections.get(target_id);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice_candidate', {
        sender_id: userId,
        candidate
      });
    }
  });

  // إنهاء/رفض المكالمة
  socket.on('end_call', async (data) => {
    const { target_id } = data;

    // حفظ سجل المكالمة عند إنهائها
    await handleCallTermination(userId);

    const targetSocketId = activeConnections.get(target_id);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call_ended', {
        sender_id: userId
      });
    }
  });

  // عند قطع الاتصال (Disconnect)
  socket.on('disconnect', async () => {
    console.log(`🔌 مستخدم غادر الاتصال: ${username} (${userId})`);
    
    // إنهاء المكالمة الجارية إن وجدت وحفظ السجل
    const callObj = activeCalls.get(userId);
    if (callObj) {
      await handleCallTermination(userId);
      const otherId = callObj.callerId === userId ? callObj.receiverId : callObj.callerId;
      const otherSocketId = activeConnections.get(otherId);
      if (otherSocketId) {
        io.to(otherSocketId).emit('call_ended', {
          sender_id: userId
        });
      }
    }

    activeConnections.delete(userId);
    
    try {
      await db.execute({
        sql: 'UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?',
        args: [userId]
      });
      
      // إبلاغ جهات الاتصال أن المستخدم أصبح غير متصل (Offline)
      broadcastPresence(userId, false);
    } catch (err) {
      console.error('Error updating presence offline:', err);
    }
  });
});

// دالة لإرسال حالة التواجد إلى جميع جهات الاتصال النشطة
async function broadcastPresence(userId, isOnline) {
  try {
    // جلب كل المستخدمين الذين لديهم محادثات نشطة مقبولة مع هذا المستخدم
    const contactsResult = await db.execute({
      sql: `SELECT DISTINCT user_id FROM conversation_members 
            WHERE conversation_id IN (
              SELECT conversation_id FROM conversation_members WHERE user_id = ?
            ) AND user_id != ?`,
      args: [userId, userId]
    });

    for (const row of contactsResult.rows) {
      const contactSocketId = activeConnections.get(row.user_id);
      if (contactSocketId) {
        io.to(contactSocketId).emit('presence_change', {
          user_id: userId,
          is_online: isOnline ? 1 : 0,
          last_seen: new Date().toISOString()
        });
      }
    }
  } catch (err) {
    console.error('Error broadcasting presence:', err);
  }
}

// تشغيل السيرفر
const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 السيرفر يعمل بنجاح على المنفذ: http://localhost:${PORT}`);
});

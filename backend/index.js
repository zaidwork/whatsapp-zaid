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

// استضافة ملفات الفرونت اند المبنية استاتيكياً
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// مسار فحص حالة السيرفر
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

// توجيه باقي المسارات للفرونت اند لدعم React Router
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/health')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// اختبار الاتصال بقاعدة البيانات عند بدء التشغيل
async function testDbConnection() {
  try {
    const result = await db.execute('SELECT 1');
    console.log('✅ تم الاتصال بقاعدة بيانات Turso السحابية بنجاح!');
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
      
      // حفظ الرسالة المشفرة بقاعدة بيانات Turso
      await db.execute({
        sql: `INSERT INTO messages (id, conversation_id, sender_id, encrypted_content, encryption_iv, message_type, status) 
              VALUES (?, ?, ?, ?, ?, ?, 'sent')`,
        args: [messageId, conversation_id, userId, encrypted_content, encryption_iv, message_type || 'text']
      });

      const messagePayload = {
        id: messageId,
        conversation_id,
        sender_id: userId,
        encrypted_content,
        encryption_iv,
        message_type: message_type || 'text',
        status: 'sent',
        created_at: new Date().toISOString()
      };

      // إذا كان المستقبل متصلاً، أرسل الرسالة له فوراً
      const receiverSocketId = activeConnections.get(receiver_id);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('new_message', messagePayload);
        
        // تحديث حالة الرسالة لمستلمة (delivered)
        await db.execute({
          sql: "UPDATE messages SET status = 'delivered' WHERE id = ?",
          args: [messageId]
        });
        messagePayload.status = 'delivered';
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
  socket.on('end_call', (data) => {
    const { target_id } = data;
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

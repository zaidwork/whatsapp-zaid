import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// 1. إرسال طلب مراسلة (Send Chat Request)
router.post('/request/send', authenticateToken, async (req, res) => {
  const { receiver_id } = req.body;
  const sender_id = req.user.id;

  if (!receiver_id) {
    return res.status(400).json({ error: 'يرجى تحديد المعرف الفريد للمستلم.' });
  }

  if (sender_id === receiver_id) {
    return res.status(400).json({ error: 'لا يمكنك إرسال طلب مراسلة لنفسك!' });
  }

  try {
    // التأكد من عدم وجود طلب مسبق (بأي حالة: معلق، مقبول، مرفوض)
    const checkRequest = await db.execute({
      sql: `SELECT status FROM chat_requests 
            WHERE (sender_id = ? AND receiver_id = ?) 
               OR (sender_id = ? AND receiver_id = ?)`,
      args: [sender_id, receiver_id, receiver_id, sender_id]
    });

    if (checkRequest.rows.length > 0) {
      const status = checkRequest.rows[0].status;
      if (status === 'accepted') {
        return res.status(400).json({ error: 'أنت متصل بالفعل بهذا المستخدم.' });
      }
      return res.status(400).json({ error: 'يوجد طلب مراسلة معلق أو سابق بينكما بالفعل.' });
    }

    // إدراج طلب جديد
    const requestId = uuidv4();
    await db.execute({
      sql: `INSERT INTO chat_requests (id, sender_id, receiver_id, status) 
            VALUES (?, ?, ?, 'pending')`,
      args: [requestId, sender_id, receiver_id]
    });

    res.json({ message: 'تم إرسال طلب المراسلة بنجاح! بانتظار موافقة الطرف الآخر.' });
  } catch (err) {
    console.error('Send request error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء إرسال طلب المراسلة.' });
  }
});

// 2. قبول طلب المراسلة وبدء محادثة (Accept Chat Request)
router.post('/request/accept', authenticateToken, async (req, res) => {
  const { sender_id } = req.body; // الشخص الذي أرسل الطلب
  const receiver_id = req.user.id; // المستخدم الحالي الذي يقبل الطلب

  if (!sender_id) {
    return res.status(400).json({ error: 'يرجى تحديد مرسل الطلب.' });
  }

  try {
    // التحقق من وجود الطلب وحالته المعلقة
    const requestResult = await db.execute({
      sql: `SELECT id FROM chat_requests 
            WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
      args: [sender_id, receiver_id]
    });

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: 'لا يوجد طلب مراسلة معلق من هذا المستخدم.' });
    }

    // تحديث حالة الطلب إلى مقبول
    await db.execute({
      sql: `UPDATE chat_requests SET status = 'accepted' WHERE sender_id = ? AND receiver_id = ?`,
      args: [sender_id, receiver_id]
    });

    // إنشاء محادثة جديدة (Conversation)
    const conversationId = uuidv4();
    await db.execute({
      sql: `INSERT INTO conversations (id, is_group) VALUES (?, 0)`,
      args: [conversationId]
    });

    // إضافة الطرفين كأعضاء في المحادثة
    await db.execute({
      sql: `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`,
      args: [conversationId, sender_id]
    });

    await db.execute({
      sql: `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`,
      args: [conversationId, receiver_id]
    });

    res.json({
      message: 'تم قبول طلب المراسلة وبدء المحادثة المشفرة!',
      conversation_id: conversationId
    });
  } catch (err) {
    console.error('Accept request error:', err);
    res.status(500).json({ error: 'حدث خطأ في السيرفر أثناء قبول طلب المراسلة.' });
  }
});

// 3. رفض طلب المراسلة (Reject Chat Request)
router.post('/request/reject', authenticateToken, async (req, res) => {
  const { sender_id } = req.body;
  const receiver_id = req.user.id;

  try {
    const result = await db.execute({
      sql: `UPDATE chat_requests SET status = 'rejected' 
            WHERE sender_id = ? AND receiver_id = ? AND status = 'pending'`,
      args: [sender_id, receiver_id]
    });

    if (result.rowsAffected === 0) {
      return res.status(404).json({ error: 'لا يوجد طلب مراسلة معلق لرفضه.' });
    }

    res.json({ message: 'تم رفض طلب المراسلة.' });
  } catch (err) {
    res.status(500).json({ error: 'حدث خطأ أثناء رفض الطلب.' });
  }
});

// 4. عرض طلبات المراسلة المعلقة الواردة (Get Incoming Pending Requests)
router.get('/requests/pending', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT cr.id as request_id, cr.created_at, u.id as user_id, u.name, u.email, u.phone_number, u.avatar_url, u.status 
            FROM chat_requests cr
            JOIN users u ON cr.sender_id = u.id
            WHERE cr.receiver_id = ? AND cr.status = 'pending'`,
      args: [req.user.id]
    });

    res.json({ requests: result.rows });
  } catch (err) {
    console.error('Get requests error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب طلبات المراسلة.' });
  }
});

// 5. جلب قائمة جهات الاتصال النشطة (Get Chats/Contacts list)
router.get('/contacts', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    // جلب كل المحادثات الثنائية التي يشارك فيها المستخدم
    const result = await db.execute({
      sql: `SELECT c.id as conversation_id, c.is_group, c.name as group_name, c.avatar_url as group_avatar,
                   u.id as user_id, u.name, u.email, u.phone_number, u.avatar_url, u.status, u.is_online, u.last_seen
            FROM conversations c
            JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
            JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id != ?
            JOIN users u ON cm2.user_id = u.id
            WHERE c.is_group = 0`,
      args: [userId, userId]
    });

    // جلب آخر رسالة في كل محادثة (لتحسين تجربة الاستخدام)
    const chats = [];
    for (const row of result.rows) {
      const lastMsgResult = await db.execute({
        sql: `SELECT encrypted_content, encryption_iv, created_at, sender_id, status 
              FROM messages 
              WHERE conversation_id = ? 
              ORDER BY created_at DESC LIMIT 1`,
        args: [row.conversation_id]
      });

      chats.push({
        ...row,
        last_message: lastMsgResult.rows.length > 0 ? lastMsgResult.rows[0] : null
      });
    }

    res.json({ chats });
  } catch (err) {
    console.error('Get contacts error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب جهات الاتصال.' });
  }
});

// 6. جلب الرسائل السابقة لمحادثة (Get Conversation Messages)
router.get('/messages/:conversationId', authenticateToken, async (req, res) => {
  const { conversationId } = req.params;
  const userId = req.user.id;

  try {
    // التأكد من أن المستخدم عضو في هذه المحادثة
    const isMember = await db.execute({
      sql: 'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      args: [conversationId, userId]
    });

    if (isMember.rows.length === 0) {
      return res.status(403).json({ error: 'ليس لديك صلاحية لعرض رسائل هذه المحادثة.' });
    }

    // جلب الرسائل
    const result = await db.execute({
      sql: `SELECT id, sender_id, encrypted_content, encryption_iv, message_type, status, created_at 
            FROM messages 
            WHERE conversation_id = ? 
            ORDER BY created_at ASC`,
      args: [conversationId]
    });

    res.json({ messages: result.rows });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب الرسائل.' });
  }
});

// 7. رفع مفاتيح التشفير للمستخدم (Upload E2EE Keys)
router.post('/keys/upload', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { public_identity_key, public_signed_prekey, prekey_signature, one_time_prekeys, encrypted_private_key } = req.body;

  if (!public_identity_key || !public_signed_prekey || !prekey_signature) {
    return res.status(400).json({ error: 'يرجى تقديم مفتاح الهوية والمفتاح الموقع مع التوقيع.' });
  }

  try {
    // إدراج أو تحديث المفاتيح الأساسية مع المفتاح الخاص المشفر
    await db.execute({
      sql: `INSERT INTO user_encryption_keys (user_id, public_identity_key, public_signed_prekey, prekey_signature, encrypted_private_key, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET 
              public_identity_key = excluded.public_identity_key,
              public_signed_prekey = excluded.public_signed_prekey,
              prekey_signature = excluded.prekey_signature,
              encrypted_private_key = COALESCE(excluded.encrypted_private_key, user_encryption_keys.encrypted_private_key),
              updated_at = CURRENT_TIMESTAMP`,
      args: [userId, public_identity_key, public_signed_prekey, prekey_signature, encrypted_private_key || null]
    });

    // إدراج مفاتيح الاستخدام لمرة واحدة (One-Time Prekeys) إن وجدت
    if (one_time_prekeys && Array.isArray(one_time_prekeys)) {
      // حذف المفاتيح القديمة غير المستخدمة أولاً لتجنب التراكم
      await db.execute({
        sql: `DELETE FROM user_one_time_prekeys WHERE user_id = ? AND is_used = 0`,
        args: [userId]
      });

      for (const key of one_time_prekeys) {
        await db.execute({
          sql: `INSERT INTO user_one_time_prekeys (user_id, key_id, public_key, is_used) 
                VALUES (?, ?, ?, 0)`,
          args: [userId, key.key_id, key.public_key]
        });
      }
    }

    res.json({ message: 'تم حفظ مفاتيح التشفير بنجاح على السيرفر.' });
  } catch (err) {
    console.error('Keys upload error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء رفع مفاتيح التشفير.' });
  }
});

// 8. جلب مفاتيح تشفير مستخدم آخر لبدء المحادثة (Get User E2EE Keys)
router.get('/keys/get/:userId', authenticateToken, async (req, res) => {
  const targetUserId = req.params.userId;

  try {
    // جلب المفاتيح الأساسية
    const keysResult = await db.execute({
      sql: `SELECT public_identity_key, public_signed_prekey, prekey_signature 
            FROM user_encryption_keys 
            WHERE user_id = ?`,
      args: [targetUserId]
    });

    if (keysResult.rows.length === 0) {
      return res.status(404).json({ error: 'المستلم لم يقم بتفعيل التشفير E2EE بعد.' });
    }

    const baseKeys = keysResult.rows[0];

    // جلب مفتاح واحد من نوع One-time Prekey غير مستخدم وماركته كـ "مستخدم" لمنع تكراره
    const otkResult = await db.execute({
      sql: `SELECT id, key_id, public_key 
            FROM user_one_time_prekeys 
            WHERE user_id = ? AND is_used = 0 
            LIMIT 1`,
      args: [targetUserId]
    });

    let oneTimePrekey = null;
    if (otkResult.rows.length > 0) {
      const otk = otkResult.rows[0];
      oneTimePrekey = {
        key_id: otk.key_id,
        public_key: otk.public_key
      };

      // وسم المفتاح كمستعمل
      await db.execute({
        sql: `UPDATE user_one_time_prekeys SET is_used = 1 WHERE id = ?`,
        args: [otk.id]
      });
    }

    res.json({
      public_identity_key: baseKeys.public_identity_key,
      public_signed_prekey: baseKeys.public_signed_prekey,
      prekey_signature: baseKeys.prekey_signature,
      one_time_prekey: oneTimePrekey
    });
  } catch (err) {
    console.error('Get keys error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب مفاتيح التشفير.' });
  }
});

export default router;

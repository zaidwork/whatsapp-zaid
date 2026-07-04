import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'whatsapp_clone_default_secret_key';

// Middleware للتحقق من التوكن (JWT Authentication Middleware)
export const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'عذراً، يجب تسجيل الدخول للوصول إلى هذه الخدمة.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'جلسة عمل منتهية أو توكن غير صالح.' });
  }
};

// 1. تسجيل مستخدم جديد (Register User)
router.post('/register', async (req, res) => {
  const { name, email, phone_number, password } = req.body;

  if (!name || !email || !phone_number || !password) {
    return res.status(400).json({ error: 'يرجى ملء جميع الحقول المطلوبة.' });
  }

  try {
    // التحقق من تكرار البريد أو الهاتف
    const checkUser = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ? OR phone_number = ?',
      args: [email, phone_number]
    });

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ error: 'البريد الإلكتروني أو رقم الهاتف مسجل بالفعل!' });
    }

    // تشفير كلمة المرور
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    const userId = uuidv4();

    // إضافة المستخدم لقاعدة البيانات
    await db.execute({
      sql: `INSERT INTO users (id, name, email, phone_number, password_hash) 
            VALUES (?, ?, ?, ?, ?)`,
      args: [userId, name, email, phone_number, passwordHash]
    });

    // إنشاء توكن الجلسة
    const token = jwt.sign({ id: userId, email, name, phone_number }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'تم إنشاء الحساب بنجاح!',
      token,
      user: { id: userId, name, email, phone_number }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'حدث خطأ في السيرفر أثناء تسجيل الحساب.' });
  }
});

// 2. تسجيل الدخول (Login User)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'يرجى إدخال البريد الإلكتروني وكلمة المرور.' });
  }

  try {
    // جلب بيانات المستخدم
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email]
    });

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    }

    const user = result.rows[0];

    // التحقق من كلمة المرور
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.' });
    }

    // إنشاء توكن الجلسة
    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, phone_number: user.phone_number }, 
      JWT_SECRET, 
      { expiresIn: '7d' }
    );

    res.json({
      message: 'تم تسجيل الدخول بنجاح!',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone_number: user.phone_number,
        avatar_url: user.avatar_url,
        status: user.status
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'حدث خطأ في السيرفر أثناء تسجيل الدخول.' });
  }
});

// 3. الحصول على بيانات المستخدم الحالي (Get Me)
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, name, email, phone_number, avatar_url, status FROM users WHERE id = ?',
      args: [req.user.id]
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'المستخدم غير موجود.' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'حدث خطأ في السيرفر.' });
  }
});

// 4. البحث عن مستخدم بواسطة رقم الهاتف (Search User by Phone)
router.get('/search', authenticateToken, async (req, res) => {
  const { phone } = req.query;

  if (!phone) {
    return res.status(400).json({ error: 'يرجى توفير رقم الهاتف للبحث.' });
  }

  try {
    const result = await db.execute({
      sql: `SELECT id, name, email, phone_number, avatar_url, status 
            FROM users 
            WHERE phone_number = ?`,
      args: [phone]
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'لم يتم العثور على مستخدم مسجل بهذا الرقم.' });
    }

    const foundUser = result.rows[0];

    // التحقق من حالة المراسلة الحالية بين المستخدم الحالي والمستخدم المبحوث عنه
    const relationResult = await db.execute({
      sql: `SELECT status, sender_id, receiver_id 
            FROM chat_requests 
            WHERE (sender_id = ? AND receiver_id = ?) 
               OR (sender_id = ? AND receiver_id = ?)`,
      args: [req.user.id, foundUser.id, foundUser.id, req.user.id]
    });

    let relation = 'none'; // none, pending_sent, pending_received, accepted, rejected
    if (relationResult.rows.length > 0) {
      const rel = relationResult.rows[0];
      if (rel.status === 'accepted') {
        relation = 'accepted';
      } else if (rel.status === 'rejected') {
        relation = 'rejected';
      } else if (rel.status === 'pending') {
        relation = rel.sender_id === req.user.id ? 'pending_sent' : 'pending_received';
      }
    }

    res.json({
      user: foundUser,
      relation
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء البحث عن المستخدم.' });
  }
});

export default router;

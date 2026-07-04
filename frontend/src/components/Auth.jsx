import React, { useState } from 'react';
import { generateE2EEKeyPair, exportPrivateKey } from '../crypto';
import { Shield, Lock, Mail, Phone, User, ArrowRightLeft } from 'lucide-react';

export default function Auth({ onAuthSuccess, serverUrl }) {
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone_number: '',
    password: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
      const body = isLogin 
        ? { email: formData.email, password: formData.password }
        : { name: formData.name, email: formData.email, phone_number: formData.phone_number, password: formData.password };

      // 1. إجراء طلب التوثيق (REST API Request)
      const res = await fetch(`${serverUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'حدث خطأ ما، يرجى المحاولة لاحقاً.');
      }

      const { token, user } = data;

      // 2. إعداد وإدارة مفاتيح التشفير للطرفين (E2EE Key Management)
      let localPrivateKey = localStorage.getItem(`e2ee_private_${user.id}`);
      
      if (!isLogin && !localPrivateKey) {
        // إذا كان تسجيلاً جديداً: توليد مفاتيح E2EE جديدة بالكامل
        const keypair = await generateE2EEKeyPair();
        
        // حفظ المفتاح الخاص بشكل آمن محلياً
        const exportedPrivate = await exportPrivateKey(keypair.privateKey);
        localStorage.setItem(`e2ee_private_${user.id}`, exportedPrivate);

        // توليد 10 مفاتيح إضافية للاستخدام لمرة واحدة (One-Time Prekeys) للرسائل أوفلاين
        const oneTimePrekeys = [];
        for (let i = 1; i <= 10; i++) {
          const otk = await generateE2EEKeyPair();
          oneTimePrekeys.push({
            key_id: i,
            public_key: otk.publicKeyJwk
          });
        }

        // رفع المفاتيح العامة للسيرفر لتخزينها بجدول user_encryption_keys و user_one_time_prekeys
        const keysRes = await fetch(`${serverUrl}/api/chat/keys/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            public_identity_key: keypair.publicKeyJwk,
            public_signed_prekey: keypair.publicKeyJwk, // نستخدم نفس المفتاح حالياً للتبسيط
            prekey_signature: 'self_signed_signature',
            one_time_prekeys: oneTimePrekeys
          })
        });

        if (!keysRes.ok) {
          console.warn('⚠️ فشل رفع مفاتيح التشفير العام للسيرفر، ولكن تم تسجيل الحساب.');
        }
      } else if (isLogin && !localPrivateKey) {
        // إذا كان تسجيل دخول من جهاز جديد ولم يكن هناك مفتاح خاص مخزن
        // لتسهيل تجربة الاستخدام، سنقوم بتوليد زوج مفاتيح جديد لهذا الجهاز ونرفعه للسيرفر
        const keypair = await generateE2EEKeyPair();
        const exportedPrivate = await exportPrivateKey(keypair.privateKey);
        localStorage.setItem(`e2ee_private_${user.id}`, exportedPrivate);

        await fetch(`${serverUrl}/api/chat/keys/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            public_identity_key: keypair.publicKeyJwk,
            public_signed_prekey: keypair.publicKeyJwk,
            prekey_signature: 'self_signed_signature'
          })
        });
      }

      // إشعار التطبيق الرئيسي بنجاح التوثيق وحفظ التوكن
      onAuthSuccess(token, user);
    } catch (err) {
      setError(err.message || 'فشل الاتصال بالسيرفر.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container} className="animate-fade-in" id="auth-page">
      <div style={styles.card} className="glass-panel">
        <div style={styles.header}>
          <div style={styles.logoContainer} className="pulse-primary">
            <Shield size={36} color="#e9edef" />
          </div>
          <h1 style={styles.title}>واتساب الشخصي الآمن</h1>
          <p style={styles.subtitle}>تواصل مشفر من الطرف إلى الطرف (E2EE)</p>
        </div>

        {error && <div style={styles.errorAlert}>{error}</div>}

        <form onSubmit={handleSubmit} style={styles.form}>
          {!isLogin && (
            <div style={styles.inputGroup}>
              <User size={18} style={styles.inputIcon} />
              <input
                type="text"
                name="name"
                placeholder="الاسم الكامل"
                value={formData.name}
                onChange={handleChange}
                style={styles.input}
                required
                id="reg-name"
              />
            </div>
          )}

          <div style={styles.inputGroup}>
            <Mail size={18} style={styles.inputIcon} />
            <input
              type="email"
              name="email"
              placeholder="البريد الإلكتروني"
              value={formData.email}
              onChange={handleChange}
              style={styles.input}
              required
              id="auth-email"
            />
          </div>

          {!isLogin && (
            <div style={styles.inputGroup}>
              <Phone size={18} style={styles.inputIcon} />
              <input
                type="tel"
                name="phone_number"
                placeholder="رقم الهاتف (البحث للمراسلة)"
                value={formData.phone_number}
                onChange={handleChange}
                style={styles.input}
                required
                id="reg-phone"
              />
            </div>
          )}

          <div style={styles.inputGroup}>
            <Lock size={18} style={styles.inputIcon} />
            <input
              type="password"
              name="password"
              placeholder="كلمة المرور"
              value={formData.password}
              onChange={handleChange}
              style={styles.input}
              required
              id="auth-password"
            />
          </div>

          <button type="submit" disabled={loading} style={styles.submitBtn} id="auth-submit">
            {loading ? 'جاري التحميل...' : isLogin ? 'تسجيل الدخول' : 'إنشاء حساب جديد'}
          </button>
        </form>

        <div style={styles.toggleContainer}>
          <button 
            type="button" 
            onClick={() => {
              setIsLogin(!isLogin);
              setError('');
            }}
            style={styles.toggleBtn}
            id="auth-toggle"
          >
            <ArrowRightLeft size={16} style={{ marginLeft: '8px' }} />
            {isLogin ? 'لا تملك حساباً؟ سجل الآن' : 'لديك حساب بالفعل؟ سجل دخولك'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
    height: '100vh',
    background: 'radial-gradient(circle at 50% 50%, #102a1e 0%, #0b141a 100%)',
    padding: '20px',
  },
  card: {
    width: '100%',
    maxWidth: '430px',
    padding: '40px 30px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  header: {
    textAlign: 'center',
    marginBottom: '30px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  logoContainer: {
    width: '70px',
    height: '70px',
    borderRadius: '50%',
    backgroundColor: 'var(--primary)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: '15px',
  },
  title: {
    fontSize: '24px',
    fontWeight: '700',
    color: 'var(--text-primary)',
    marginBottom: '6px',
  },
  subtitle: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
  },
  errorAlert: {
    backgroundColor: 'rgba(234, 0, 56, 0.15)',
    border: '1px solid var(--accent-reject)',
    color: '#ff4d6d',
    padding: '10px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    marginBottom: '20px',
    textAlign: 'center',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  inputGroup: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  inputIcon: {
    position: 'absolute',
    right: '14px',
    color: 'var(--text-secondary)',
  },
  input: {
    width: '100%',
    padding: '14px 44px 14px 14px',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    border: '1px solid var(--border-color)',
    borderRadius: '10px',
    color: 'var(--text-primary)',
    fontSize: '14px',
    transition: 'var(--transition)',
  },
  submitBtn: {
    width: '100%',
    padding: '14px',
    backgroundColor: 'var(--primary)',
    color: '#ffffff',
    fontSize: '15px',
    fontWeight: '600',
    borderRadius: '10px',
    marginTop: '10px',
    boxShadow: '0 4px 14px var(--primary-glow)',
  },
  toggleContainer: {
    marginTop: '25px',
    display: 'flex',
    justifyContent: 'center',
  },
  toggleBtn: {
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: '13.5px',
    display: 'flex',
    alignItems: 'center',
    transition: 'var(--transition)',
    padding: '6px 12px',
    borderRadius: '6px',
  }
};

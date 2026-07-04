// =========================================================================
// محرك التشفير من الطرف إلى الطرف (E2EE) مع دعم وضع التوافق للشبكات المحلية (HTTP Fallback)
// =========================================================================

// مساعدات التحويل (Helper utilities)
function arrayBufferToBase64(buffer) {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// التحقق مما إذا كان المتصفح يدعم محرك التشفير في البيئة الحالية
const isSecureContext = !!(window.crypto && window.crypto.subtle);

if (!isSecureContext) {
  console.warn("⚠️ تم اكتشاف بيئة عمل غير مشفرة (HTTP). تم تفعيل وضع التجربة المحلية (Insecure Fallback Mode) لتجنب توقف التطبيق.");
}

// 1. توليد زوج مفاتيح التشفير ECDH P-256 للمستخدم
export async function generateE2EEKeyPair() {
  if (!isSecureContext) {
    // وضع التوافق: مفاتيح وهمية للتجربة المحلية لتفادي خطأ المتصفح
    const mockId = Math.random().toString(36).substring(7);
    return {
      publicKeyJwk: JSON.stringify({ kty: "mock", kid: "mock_" + mockId, val: mockId }),
      privateKey: { type: "private", mock: true, id: mockId }
    };
  }

  try {
    const keyPair = await window.crypto.subtle.generateKey(
      {
        name: 'ECDH',
        namedCurve: 'P-256'
      },
      true,
      ['deriveKey', 'deriveBits']
    );

    const publicJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
    
    return {
      publicKeyJwk: JSON.stringify(publicJwk),
      privateKey: keyPair.privateKey
    };
  } catch (err) {
    console.error('Error generating keypair:', err);
    throw err;
  }
}

// 2. حفظ المفتاح الخاص محلياً
export async function exportPrivateKey(privateKey) {
  if (privateKey.mock) {
    return JSON.stringify(privateKey);
  }
  const jwk = await window.crypto.subtle.exportKey('jwk', privateKey);
  return JSON.stringify(jwk);
}

// 3. استرجاع المفتاح الخاص من الـ LocalStorage وإعادة بنائه
export async function importPrivateKey(jwkString) {
  const parsed = JSON.parse(jwkString);
  if (parsed.mock) {
    return parsed;
  }

  return await window.crypto.subtle.importKey(
    'jwk',
    parsed,
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    ['deriveKey', 'deriveBits']
  );
}

// 4. استيراد المفتاح العام الخاص بالطرف الآخر
export async function importPublicKey(jwkString) {
  const parsed = JSON.parse(jwkString);
  if (parsed.kty === "mock") {
    return parsed;
  }

  return await window.crypto.subtle.importKey(
    'jwk',
    parsed,
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    []
  );
}

// 5. اشتقاق مفتاح تشفير مشترك (Shared AES-256 Key)
export async function deriveSharedKey(privateKey, otherPublicJwkString) {
  const otherParsed = JSON.parse(otherPublicJwkString);
  
  if (privateKey.mock || otherParsed.kty === "mock") {
    // وضع التوافق: محاكاة مفتاح تشفير مشترك
    return { mock: true, key: "shared_mock_secret_" + (privateKey.id || "key") };
  }

  try {
    const otherPublicKey = await importPublicKey(otherPublicJwkString);
    
    return await window.crypto.subtle.deriveKey(
      {
        name: 'ECDH',
        public: otherPublicKey
      },
      privateKey,
      {
        name: 'AES-GCM',
        length: 256
      },
      false,
      ['encrypt', 'decrypt']
    );
  } catch (err) {
    console.error('Error deriving shared key:', err);
    throw err;
  }
}

// 6. تشفير رسالة نصية باستخدام المفتاح المشترك (AES-GCM 256)
export async function encryptMessage(sharedKey, plainText) {
  if (sharedKey.mock) {
    // وضع التوافق: ترميز النص بـ Base64 للتجربة من الهواتف المحلية
    const utf8Text = unescape(encodeURIComponent(plainText));
    return {
      ciphertext: window.btoa(utf8Text),
      iv: "insecure_fallback_iv"
    };
  }

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(plainText);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    const ciphertextBuffer = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      sharedKey,
      data
    );

    return {
      ciphertext: arrayBufferToBase64(ciphertextBuffer),
      iv: arrayBufferToBase64(iv)
    };
  } catch (err) {
    console.error('Encryption failed:', err);
    throw err;
  }
}

// 7. فك تشفير رسالة باستخدام المفتاح المشترك (AES-GCM 256)
export async function decryptMessage(sharedKey, ciphertextBase64, ivBase64) {
  if (sharedKey.mock) {
    // وضع التوافق: فك ترميز Base64
    try {
      const decoded = window.atob(ciphertextBase64);
      return decodeURIComponent(escape(decoded));
    } catch (e) {
      return "🔒 [رسالة مشفرة للتجربة]";
    }
  }

  try {
    const ciphertext = base64ToArrayBuffer(ciphertextBase64);
    const iv = base64ToArrayBuffer(ivBase64);
    
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv
      },
      sharedKey,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedBuffer);
  } catch (err) {
    console.error('Decryption failed.', err);
    return '🔒 [فشل فك تشفير الرسالة - مشكلة في تبادل المفاتيح]';
  }
}
export { isSecureContext };

-- =========================================================================
-- قاعدة بيانات تطبيق محادثة شخصي شبيه بـ WhatsApp (كاملة ومتكاملة)
-- متوافقة مع SQLite / LibSQL (Turso) وتدعم التشفير من طرف لطرف والمجموعات والمكالمات والحالات
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. جدول المستخدمين (users)
-- -------------------------------------------------------------------------
CREATE TABLE users (
    id TEXT PRIMARY KEY, -- يتم توليد UUID في التطبيق
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone_number TEXT UNIQUE NOT NULL, -- رقم الهاتف الفريد للبحث عن المستخدم
    password_hash TEXT NOT NULL, -- كلمة المرور المشفرة بالسيرفر
    avatar_url TEXT DEFAULT NULL, -- رابط الصورة الشخصية
    status TEXT DEFAULT 'مرحباً! أنا أستخدم تطبيق المحادثة الخاص بي.', -- الحالة الشخصية (Bio)
    
    -- حالة التواجد (User Presence)
    is_online INTEGER DEFAULT 0, -- 0 للمخفي/أوفلاين، 1 للنشط/أونلاين
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 2. جدول أجهزة المستخدمين (user_devices)
-- -------------------------------------------------------------------------
CREATE TABLE user_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT NOT NULL, -- مثل: Chrome Windows, iPhone 14
    registration_id INTEGER NOT NULL, -- معرف التسجيل المستخدم في بروتوكول التشفير Signal
    push_token TEXT DEFAULT NULL, -- رمز الإشعارات الفورية
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 3. جدول جلسات تسجيل الدخول (user_sessions)
-- -------------------------------------------------------------------------
CREATE TABLE user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES user_devices(id) ON DELETE SET NULL,
    refresh_token TEXT UNIQUE NOT NULL,
    user_agent TEXT DEFAULT NULL,
    ip_address TEXT DEFAULT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 4. جدول مفاتيح التشفير العام الأساسية (user_encryption_keys)
-- -------------------------------------------------------------------------
CREATE TABLE user_encryption_keys (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_identity_key TEXT NOT NULL, -- المفتاح العام الثابت للهوية (Identity Key - IK)
    public_signed_prekey TEXT NOT NULL, -- المفتاح العام الموقع (Signed Prekey - SPK)
    prekey_signature TEXT NOT NULL, -- التوقيع الرقمي للمفتاح الموقع
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 5. جدول مفاتيح التشفير التي تستخدم لمرة واحدة (user_one_time_prekeys)
-- -------------------------------------------------------------------------
CREATE TABLE user_one_time_prekeys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_id INTEGER NOT NULL, -- معرف المفتاح الفريد لدى المستخدم
    public_key TEXT NOT NULL, -- قيمة المفتاح العام للاستخدام لمرة واحدة
    is_used INTEGER DEFAULT 0, -- 0 غير مستخدم، 1 مستخدم
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 6. جدول طلبات المراسلة (chat_requests)
-- -------------------------------------------------------------------------
CREATE TABLE chat_requests (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending', -- الحالات: 'pending', 'accepted', 'rejected'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    -- قيد لمنع تكرار طلبات المراسلة بين نفس المستخدمين
    CONSTRAINT unique_sender_receiver UNIQUE (sender_id, receiver_id),
    -- قيد يمنع الشخص من إرسال طلب لنفسه
    CONSTRAINT check_sender_different_than_receiver CHECK (sender_id <> receiver_id)
);

-- -------------------------------------------------------------------------
-- 7. جدول المحادثات (conversations)
-- -------------------------------------------------------------------------
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    is_group INTEGER DEFAULT 0, -- 0 محادثة ثنائية، 1 مجموعة
    name TEXT DEFAULT NULL, -- اسم المجموعة
    avatar_url TEXT DEFAULT NULL, -- صورة المجموعة
    creator_id TEXT REFERENCES users(id) ON DELETE SET NULL, -- منشئ المجموعة
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 8. جدول أعضاء المحادثة (conversation_members)
-- -------------------------------------------------------------------------
CREATE TABLE conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member', -- الأدوار: 'member', 'admin'
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id)
);

-- -------------------------------------------------------------------------
-- 9. جدول الرسائل المشفرة (messages)
-- -------------------------------------------------------------------------
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_content TEXT NOT NULL, -- المحتوى النصي المشفر بالكامل (Ciphertext)
    encryption_iv TEXT NOT NULL, -- متجه التهيئة (IV) المستخدم في التشفير
    message_type TEXT NOT NULL DEFAULT 'text', -- أنواع الرسائل: 'text', 'media', 'call_log'
    status TEXT NOT NULL DEFAULT 'sent', -- الحالات: 'sent', 'delivered', 'read'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 10. جدول مرفقات الرسائل (message_attachments)
-- -------------------------------------------------------------------------
CREATE TABLE message_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL, -- رابط الملف المشفر
    file_name TEXT NOT NULL, -- اسم الملف الأصلي
    file_type TEXT NOT NULL, -- نوع الملف (MIME Type)
    file_size INTEGER NOT NULL, -- حجم الملف بالبايت
    encrypted_file_key TEXT NOT NULL, -- مفتاح تشفير الملف نفسه
    encryption_iv TEXT NOT NULL, -- متجه التهيئة للملف
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- 11. جدول حظر المستخدمين (blocked_users)
-- -------------------------------------------------------------------------
CREATE TABLE blocked_users (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- المستخدم الذي قام بالحظر
    blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- المستخدم المحظور
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, blocked_user_id),
    CONSTRAINT check_not_blocking_self CHECK (user_id <> blocked_user_id)
);

-- -------------------------------------------------------------------------
-- 12. جدول سجل المكالمات (calls)
-- -------------------------------------------------------------------------
CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    is_group_call INTEGER DEFAULT 0,
    call_type TEXT NOT NULL, -- أنواع المكالمات: 'audio', 'video'
    status TEXT NOT NULL DEFAULT 'ringing', -- الحالات: 'ringing', 'answered', 'rejected', 'missed', 'ended'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME DEFAULT NULL,
    ended_at DATETIME DEFAULT NULL
);

-- -------------------------------------------------------------------------
-- 13. جدول الحالات / القصص (user_statuses)
-- -------------------------------------------------------------------------
CREATE TABLE user_statuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_url TEXT DEFAULT NULL, -- رابط الصورة أو الفيديو
    caption TEXT DEFAULT NULL, -- النص المرافق للحالة
    status_type TEXT NOT NULL DEFAULT 'text', -- أنواع الحالات: 'text', 'image', 'video'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL DEFAULT (datetime(CURRENT_TIMESTAMP, '+24 hours')) -- تنتهي بعد 24 ساعة
);

-- -------------------------------------------------------------------------
-- 14. جدول مشاهدات الحالة (status_views)
-- -------------------------------------------------------------------------
CREATE TABLE status_views (
    status_id TEXT NOT NULL REFERENCES user_statuses(id) ON DELETE CASCADE,
    viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (status_id, viewer_id)
);

-- =========================================================================
-- الفهارس (Indexes) لتسريع عمليات البحث والاستعلام
-- =========================================================================

-- تسريع البحث عن المستخدمين بواسطة رقم الهاتف (أهم ميزة للبحث)
CREATE INDEX idx_users_phone ON users(phone_number);

-- تسريع البحث عن المستخدمين بالبريد الإلكتروني أثناء تسجيل الدخول
CREATE INDEX idx_users_email ON users(email);

-- تسريع استرجاع طلبات المحادثة المعلقة للمستقبل
CREATE INDEX idx_chat_requests_receiver ON chat_requests(receiver_id, status);

-- تسريع جلب الرسائل الأخيرة في محادثة معينة مرتبة زمنياً
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);

-- تسريع جلب الجلسات النشطة للمستخدمين
CREATE INDEX idx_user_sessions_token ON user_sessions(refresh_token);

-- تسريع جلب الحالات النشطة غير المنتهية الصلاحية
CREATE INDEX idx_user_statuses_expiry ON user_statuses(expires_at);

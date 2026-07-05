import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, MessageSquare, UserPlus, Check, X, Send, 
  Phone, Video, ShieldCheck, LogOut, CheckCheck, 
  Image, Smile, User, Clock, Radio, PlusCircle, ArrowRight, RefreshCw
} from 'lucide-react';
import { importPrivateKey, deriveSharedKey, encryptMessage, decryptMessage, isSecureContext } from '../crypto';

export default function Dashboard({ token, myUser, socket, socketConnected, serverUrl, onLogout, onInitiateCall }) {
  const [activeChat, setActiveChat] = useState(null); // المحادثة النشطة حالياً
  const [chats, setChats] = useState([]); // قائمة المحادثات النشطة/جهات الاتصال
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const [searchPhone, setSearchPhone] = useState('');
  const [searchResult, setSearchResult] = useState(null);
  const [searchError, setSearchError] = useState('');
  const [pendingRequests, setPendingRequests] = useState([]);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  
  // حالات التواجد والكتابة
  const [typingUsers, setTypingUsers] = useState({}); // mapping conversation_id -> boolean
  const [onlineUsers, setOnlineUsers] = useState({}); // mapping user_id -> boolean
  
  // تشفير E2EE
  const [sharedKeys, setSharedKeys] = useState({}); // cache mapping user_id -> CryptoKey
  const [myPrivateKey, setMyPrivateKey] = useState(null);
  const [derivingKey, setDerivingKey] = useState(false);

  // نظام الحالات (Status Stories)
  const [showStatusPanel, setShowStatusPanel] = useState(false);
  const [statuses, setStatuses] = useState([]);
  const [statusText, setStatusText] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const activeChatRef = useRef(activeChat);
  const myPrivateKeyRef = useRef(myPrivateKey);
  const sharedKeysRef = useRef(sharedKeys);

  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);
  useEffect(() => { myPrivateKeyRef.current = myPrivateKey; }, [myPrivateKey]);
  useEffect(() => { sharedKeysRef.current = sharedKeys; }, [sharedKeys]);

  // 1. استرجاع مفتاح التشفير الخاص عند بدء التشغيل
  useEffect(() => {
    async function loadKey() {
      const storedPrivateJwk = localStorage.getItem(`e2ee_private_${myUser.id}`);
      if (storedPrivateJwk) {
        try {
          const key = await importPrivateKey(storedPrivateJwk);
          setMyPrivateKey(key);
        } catch (err) {
          console.error('Failed to import private key:', err);
        }
      }
    }
    loadKey();
    loadPendingRequests();
    loadContacts();
  }, [myUser.id]);

  // 2. إدارة أحداث الـ WebSockets الفورية
  useEffect(() => {
    if (!socket) return;

    // استلام رسالة جديدة
    const handleNewMessage = async (msg) => {
      // التحقق من وجود المفتاح المشترك المشتق
      let sharedKey = sharedKeysRef.current[msg.sender_id];
      
      // إذا لم يكن المفتاح مشتقاً ومحفوظاً، نقوم بجلبه واشتقاقه فوراً
      if (!sharedKey && myPrivateKeyRef.current) {
        try {
          sharedKey = await fetchAndDeriveKey(msg.sender_id);
        } catch (err) {
          console.error('E2EE Decrypt error: Key derivation failed', err);
        }
      }

      let decryptedContent = msg.encrypted_content;
      if (msg.message_type === 'call_log') {
        decryptedContent = msg.encrypted_content;
      } else if (sharedKey) {
        decryptedContent = await decryptMessage(sharedKey, msg.encrypted_content, msg.encryption_iv);
      } else {
        decryptedContent = '🔒 [رسالة مشفرة - مفتاح التشفير غير متوفر]';
      }

      const decryptedMsg = {
        ...msg,
        decrypted_content: decryptedContent
      };

      // إذا كانت الرسالة تخص المحادثة المفتوحة حالياً
      if (activeChatRef.current && msg.conversation_id === activeChatRef.current.conversation_id) {
        setMessages((prev) => [...prev, decryptedMsg]);
        scrollToBottom();
      }

      // تحديث الرسالة الأخيرة في قائمة المحادثات
      setChats((prevChats) => {
        return prevChats.map((chat) => {
          if (chat.conversation_id === msg.conversation_id) {
            return {
              ...chat,
              last_message: {
                encrypted_content: msg.encrypted_content,
                encryption_iv: msg.encryption_iv,
                created_at: msg.created_at,
                sender_id: msg.sender_id,
                decrypted_content: decryptedContent
              }
            };
          }
          return chat;
        });
      });
    };

    // استلام حالة التواجد (Online/Offline) لجهات الاتصال
    const handlePresenceChange = (data) => {
      setOnlineUsers((prev) => ({
        ...prev,
        [data.user_id]: data.is_online === 1
      }));
    };

    // استلام مؤشر الكتابة (Typing indicator)
    const handleTypingStatus = (data) => {
      setTypingUsers((prev) => ({
        ...prev,
        [data.conversation_id]: data.is_typing
      }));
    };

    socket.on('new_message', handleNewMessage);
    socket.on('presence_change', handlePresenceChange);
    socket.on('typing_status', handleTypingStatus);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('presence_change', handlePresenceChange);
      socket.off('typing_status', handleTypingStatus);
    };
  }, [socket]);

  // تمرير تلقائي لأسفل المحادثة عند استلام رسائل جديدة أو انتهاء فك التشفير
  useEffect(() => {
    if (!derivingKey) {
      scrollToBottom();
    }
  }, [messages, derivingKey]);

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 80);
  };

  const handleManualRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await loadContacts();
      await loadPendingRequests();
      if (activeChat) {
        await selectChat(activeChat);
      }
    } catch (err) {
      console.error("Manual refresh error:", err);
    } finally {
      setTimeout(() => {
        setIsRefreshing(false);
      }, 500);
    }
  };

  // 3. جلب قائمة جهات الاتصال النشطة
  const loadContacts = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/chat/contacts`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setChats(data.chats || []);
        
        // تعبئة خريطة التواجد الأولية
        const presence = {};
        data.chats.forEach(chat => {
          presence[chat.user_id] = chat.is_online === 1;
        });
        setOnlineUsers(presence);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // 4. جلب طلبات المراسلة المعلقة
  const loadPendingRequests = async () => {
    try {
      const res = await fetch(`${serverUrl}/api/chat/requests/pending`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setPendingRequests(data.requests || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // 5. البحث عن مستخدم بواسطة رقم الهاتف
  const handleSearch = async (e) => {
    e.preventDefault();
    setSearchError('');
    setSearchResult(null);

    if (!searchPhone) return;

    try {
      const res = await fetch(`${serverUrl}/api/auth/search?phone=${searchPhone}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'لم يتم العثور على مستخدم.');
      }

      setSearchResult(data);
    } catch (err) {
      setSearchError(err.message);
    }
  };

  // 6. إرسال طلب مراسلة
  const sendChatRequest = async (receiverId) => {
    try {
      const res = await fetch(`${serverUrl}/api/chat/request/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ receiver_id: receiverId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      alert(data.message);
      setSearchResult(null);
      setSearchPhone('');
    } catch (err) {
      alert(err.message);
    }
  };

  // 7. قبول طلب المراسلة
  const acceptChatRequest = async (senderId) => {
    try {
      const res = await fetch(`${serverUrl}/api/chat/request/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ sender_id: senderId })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      loadPendingRequests();
      loadContacts();
    } catch (err) {
      alert(err.message);
    }
  };

  // 8. رفض طلب المراسلة
  const rejectChatRequest = async (senderId) => {
    try {
      await fetch(`${serverUrl}/api/chat/request/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ sender_id: senderId })
      });
      loadPendingRequests();
    } catch (err) {
      console.error(err);
    }
  };

  // 9. جلب واشتقاق مفتاح التشفير للطرف الآخر
  const fetchAndDeriveKey = async (targetUserId) => {
    // التحقق أولاً من الكاش
    if (sharedKeysRef.current[targetUserId]) return sharedKeysRef.current[targetUserId];

    try {
      const res = await fetch(`${serverUrl}/api/chat/keys/get/${targetUserId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'فشل جلب مفاتيح تشفير المستلم.');
      }

      // اشتقاق المفتاح المشترك عبر ECDH
      const derived = await deriveSharedKey(myPrivateKeyRef.current, data.public_identity_key);
      
      // حفظ المفتاح في الكاش لتسريع العمليات القادمة
      sharedKeysRef.current[targetUserId] = derived;
      setSharedKeys(prev => ({
        ...prev,
        [targetUserId]: derived
      }));

      return derived;
    } catch (err) {
      console.error('Key derivation error:', err);
      throw err;
    }
  };

  // 10. اختيار محادثة والبدء بها
  const selectChat = async (chat) => {
    setActiveChat(chat);
    setMessages([]);
    setDerivingKey(true);

    try {
      // جلب واشتقاق مفتاح E2EE
      const sharedKey = await fetchAndDeriveKey(chat.user_id);

      // جلب الرسائل السابقة المشفرة
      const res = await fetch(`${serverUrl}/api/chat/messages/${chat.conversation_id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();

      if (res.ok) {
        // فك تشفير الرسائل السابقة
        const decryptedList = [];
        for (const msg of data.messages) {
          if (msg.message_type === 'call_log') {
            decryptedList.push({
              ...msg,
              decrypted_content: msg.encrypted_content
            });
            continue;
          }
          try {
            const dec = await decryptMessage(sharedKey, msg.encrypted_content, msg.encryption_iv);
            decryptedList.push({
              ...msg,
              decrypted_content: dec
            });
          } catch (decErr) {
            decryptedList.push({
              ...msg,
              decrypted_content: '🔒 [فشل فك تشفير الرسالة - مشكلة تشفير]'
            });
          }
        }
        setMessages(decryptedList);
      }
    } catch (err) {
      console.error('Error opening chat:', err);
    } finally {
      setDerivingKey(false);
    }
  };

  // 11. إرسال رسالة مشفرة
  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || !activeChat || !socket) return;

    const textToSend = inputText;
    setInputText('');

    // إيقاف مؤشر الكتابة فوراً بعد الإرسال
    if (socket && activeChat) {
      socket.emit('typing_status', {
        conversation_id: activeChat.conversation_id,
        receiver_id: activeChat.user_id,
        is_typing: false
      });
    }

    try {
      const sharedKey = sharedKeys[activeChat.user_id];
      if (!sharedKey) {
        throw new Error('مفتاح التشفير المشترك غير متوفر للاتصال.');
      }

      // تشفير محتوى الرسالة قبل إرسالها (E2EE Encryption)
      const encrypted = await encryptMessage(sharedKey, textToSend);

      // إرسال الرسالة المشفرة عبر WebSockets
      socket.emit('send_message', {
        conversation_id: activeChat.conversation_id,
        receiver_id: activeChat.user_id,
        encrypted_content: encrypted.ciphertext,
        encryption_iv: encrypted.iv,
        message_type: 'text'
      }, (ack) => {
        if (ack.error) {
          alert(ack.error);
        } else if (ack.success) {
          // إضافة الرسالة المفكوكة تشفيرها محلياً لواجهة المستخدم مباشرة
          const localDecryptedMsg = {
            ...ack.message,
            decrypted_content: textToSend
          };
          setMessages(prev => [...prev, localDecryptedMsg]);
          scrollToBottom();

          // تحديث قائمة المحادثات الجانبية
          setChats((prevChats) => {
            return prevChats.map((chat) => {
              if (chat.conversation_id === activeChat.conversation_id) {
                return {
                  ...chat,
                  last_message: {
                    encrypted_content: encrypted.ciphertext,
                    encryption_iv: encrypted.iv,
                    created_at: ack.message.created_at,
                    sender_id: myUser.id,
                    decrypted_content: textToSend
                  }
                };
              }
              return chat;
            });
          });
        }
      });

    } catch (err) {
      alert(err.message);
    }
  };

  // 12. إرسال ملف مرفق مشفر (File E2EE Upload Mock)
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !activeChat) return;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const fileBase64 = reader.result; // محتوى الملف بصيغة base64
        const sharedKey = sharedKeys[activeChat.user_id];
        
        // تشفير ملف الوسائط بالكامل
        const encrypted = await encryptMessage(sharedKey, fileBase64);

        socket.emit('send_message', {
          conversation_id: activeChat.conversation_id,
          receiver_id: activeChat.user_id,
          encrypted_content: encrypted.ciphertext,
          encryption_iv: encrypted.iv,
          message_type: 'media'
        }, (ack) => {
          if (ack.success) {
            const localDecryptedMsg = {
              ...ack.message,
              decrypted_content: fileBase64 // لعرض الملف المشفر محلياً
            };
            setMessages(prev => [...prev, localDecryptedMsg]);
            scrollToBottom();
          }
        });
      } catch (err) {
        alert('فشل تشفير وإرسال الملف.');
      }
    };
    reader.readAsDataURL(file);
  };

  // 13. مؤشر الكتابة (Typing Indicator)
  const handleInputChange = (e) => {
    setInputText(e.target.value);
    
    if (socket && activeChat) {
      socket.emit('typing_status', {
        conversation_id: activeChat.conversation_id,
        receiver_id: activeChat.user_id,
        is_typing: e.target.value.length > 0
      });
    }
  };

  return (
    <div 
      style={{
        ...styles.dashboardContainer,
        padding: isMobile ? '0' : '20px',
        gap: isMobile ? '0' : '20px'
      }} 
      id="dashboard-container"
    >
      
      {/* 1. اللوحة الجانبية (Sidebar) */}
      <div 
        style={{
          ...styles.sidebar,
          display: isMobile && (activeChat || showStatusPanel) ? 'none' : 'flex',
          width: isMobile ? '100%' : '30%',
          minWidth: isMobile ? '100%' : '340px'
        }} 
        className="glass-panel"
      >
        
        {/* ملف التعريف الشخصي */}
        <div style={styles.profileHeader}>
          <div style={styles.profileInfo}>
            <div style={styles.avatar}>
              <User size={20} color="white" />
            </div>
            <div style={{ minWidth: '0', flex: 1, marginRight: '8px' }}>
              <h3 style={styles.profileName}>{myUser.name}</h3>
              <div style={{ display: 'flex', alignItems: 'center', marginTop: '2px' }}>
                <div style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  backgroundColor: socketConnected ? '#00a884' : '#ff9f1c',
                  marginLeft: '5px',
                  flexShrink: 0
                }} />
                <p style={{ 
                  fontSize: '11px', 
                  color: socketConnected ? '#00a884' : '#ff9f1c',
                  fontWeight: '600',
                  margin: 0,
                  padding: 0
                }}>
                  {socketConnected ? 'متصل بالشبكة' : 'جاري الاتصال...'}
                </p>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              onClick={handleManualRefresh} 
              style={{ 
                ...styles.iconBtn, 
                animation: isRefreshing ? 'spin 0.8s linear infinite' : 'none' 
              }}
              title="تحديث فوري"
              id="refresh-data-btn"
            >
              <RefreshCw size={20} color={isRefreshing ? '#00a884' : 'var(--text-secondary)'} />
            </button>
            <button 
              onClick={() => setShowStatusPanel(!showStatusPanel)} 
              style={{ ...styles.iconBtn, backgroundColor: showStatusPanel ? 'rgba(0,168,132,0.2)' : 'transparent' }}
              title="الحالات اليومية"
            >
              <Radio size={20} color={showStatusPanel ? '#00a884' : 'var(--text-secondary)'} />
            </button>
            <button onClick={onLogout} style={styles.iconBtn} title="تسجيل الخروج" id="logout-btn">
              <LogOut size={20} color="var(--text-secondary)" />
            </button>
          </div>
        </div>

        {/* نموذج البحث عن مستخدم بالهاتف لإرسال طلب */}
        <div style={styles.searchSection}>
          <form onSubmit={handleSearch} style={styles.searchForm}>
            <input 
              type="text" 
              placeholder="البحث برقم هاتف مسجل..." 
              value={searchPhone}
              onChange={(e) => setSearchPhone(e.target.value)}
              style={styles.searchInput}
              id="search-phone-input"
            />
            <button type="submit" style={styles.searchBtn} id="search-phone-btn">
              <Search size={18} color="white" />
            </button>
          </form>

          {/* نتيجة البحث */}
          {searchResult && (
            <div style={styles.searchResultCard} className="animate-fade-in" id="search-result">
              <div>
                <p style={{ fontWeight: '600', fontSize: '13.5px' }}>{searchResult.user.name}</p>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{searchResult.user.phone_number}</p>
              </div>
              
              {searchResult.relation === 'none' && (
                <button 
                  onClick={() => sendChatRequest(searchResult.user.id)} 
                  style={styles.addBtn}
                  id="add-contact-btn"
                >
                  <UserPlus size={16} style={{ marginLeft: '4px' }} />
                  مراسلة
                </button>
              )}
              {searchResult.relation === 'pending_sent' && (
                <span style={styles.pendingBadge}>طلب معلق</span>
              )}
              {searchResult.relation === 'pending_received' && (
                <button 
                  onClick={() => acceptChatRequest(searchResult.user.id)} 
                  style={styles.acceptBtn}
                >
                  قبول الطلب
                </button>
              )}
              {searchResult.relation === 'accepted' && (
                <span style={styles.acceptedBadge}>متصل بالفعل</span>
              )}
            </div>
          )}
          {searchError && <p style={styles.searchErrorText}>{searchError}</p>}
        </div>

        {/* صندوق طلبات المراسلة المعلقة الواردة */}
        {pendingRequests.length > 0 && (
          <div style={styles.requestsSection}>
            <h4 style={styles.sectionTitle}>طلبات مراسلة واردة ({pendingRequests.length})</h4>
            <div style={styles.requestsList}>
              {pendingRequests.map((req) => (
                <div key={req.request_id} style={styles.requestItem} className="glass-panel">
                  <div>
                    <p style={{ fontSize: '13px', fontWeight: '600' }}>{req.name}</p>
                    <p style={{ fontSize: '10.5px', color: 'var(--text-secondary)' }}>{req.phone_number}</p>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button onClick={() => acceptChatRequest(req.user_id)} style={styles.circleAcceptBtn}>
                      <Check size={14} color="white" />
                    </button>
                    <button onClick={() => rejectChatRequest(req.user_id)} style={styles.circleRejectBtn}>
                      <X size={14} color="white" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* قائمة المحادثات (Chats List) */}
        <div style={styles.chatsListSection}>
          <h4 style={styles.sectionTitle}>المحادثات المفتوحة</h4>
          <div style={styles.chatsContainer}>
            {chats.length === 0 ? (
              <div style={styles.emptyChats}>
                <MessageSquare size={36} color="var(--text-muted)" />
                <p style={{ fontSize: '13px', marginTop: '10px' }}>لا توجد محادثات نشطة بعد. ابحث عن مستخدم برقم هاتفه وابدأ المراسلة!</p>
              </div>
            ) : (
              chats.map((chat) => {
                const isActive = activeChat && activeChat.conversation_id === chat.conversation_id;
                const isOnline = onlineUsers[chat.user_id];
                const isTyping = typingUsers[chat.conversation_id];
                
                return (
                  <div 
                    key={chat.conversation_id}
                    onClick={() => selectChat(chat)}
                    style={{ 
                      ...styles.chatItem, 
                      backgroundColor: isActive ? 'rgba(255,255,255,0.06)' : 'transparent' 
                    }}
                    className="chat-list-item"
                  >
                    <div style={styles.chatAvatarWrapper}>
                      <div style={styles.chatAvatar}>
                        <User size={18} color="white" />
                      </div>
                      {isOnline && <div style={styles.onlineDot} />}
                    </div>

                    <div style={styles.chatInfo}>
                      <div style={styles.chatInfoTop}>
                        <span style={styles.chatName}>{chat.name}</span>
                        {chat.last_message && (
                          <span style={styles.chatTime}>
                            {new Date(chat.last_message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>
                      
                      <div style={styles.chatInfoBottom}>
                        {isTyping ? (
                          <span style={styles.typingText}>يكتب الآن...</span>
                        ) : (
                          <span style={styles.lastMessageText}>
                            {chat.last_message ? (
                              chat.last_message.sender_id === myUser.id ? 'أنت: ' : ''
                            ) : ''}
                            {chat.last_message?.message_type === 'call_log' ? (
                              chat.last_message.encrypted_content
                            ) : chat.last_message?.decrypted_content || chat.last_message?.encrypted_content ? (
                              chat.last_message.decrypted_content || '🔒 رسالة مشفرة'
                            ) : (
                              chat.status
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

      </div>

      {/* 2. منطقة المحادثة اليمين أو لوحة الحالات */}
      {showStatusPanel ? (
        /* لوحة الحالات (Status panel) */
        <div 
          style={{
            ...styles.chatWindow,
            display: isMobile && !showStatusPanel ? 'none' : 'flex',
            width: isMobile ? '100%' : 'auto'
          }} 
          className="glass-panel"
        >
          <div style={styles.chatHeader}>
            <div style={styles.chatHeaderLeft}>
              {isMobile && (
                <button 
                  onClick={() => setShowStatusPanel(false)} 
                  style={{ ...styles.iconBtn, marginLeft: '12px' }}
                >
                  <ArrowRight size={22} color="white" />
                </button>
              )}
              <Radio size={24} color="#00a884" style={{ marginLeft: '12px' }} />
              <div>
                <h3 style={styles.chatHeaderText}>الحالات اليومية (Stories)</h3>
                <p style={styles.chatHeaderSub}>تختفي الحالات تلقائياً بعد 24 ساعة</p>
              </div>
            </div>
            <button onClick={() => setShowStatusPanel(false)} style={styles.iconBtn}>
              <X size={20} color="white" />
            </button>
          </div>
          
          <div style={styles.statusContent}>
            {/* إضافة حالة جديدة */}
            <div style={styles.statusCreateCard} className="glass-panel">
              <textarea 
                placeholder="بماذا تفكر؟ اكتب حالتك هنا لتظهر لجهات اتصالك..."
                value={statusText}
                onChange={(e) => setStatusText(e.target.value)}
                style={styles.statusInput}
              />
              <button 
                onClick={() => {
                  if (statusText.trim()) {
                    alert('تم نشر الحالة بنجاح (محاكاة)!');
                    setStatusText('');
                  }
                }} 
                style={styles.statusPublishBtn}
              >
                <PlusCircle size={16} style={{ marginLeft: '6px' }} />
                نشر الحالة
              </button>
            </div>
            
            {/* عرض الحالات المتاحة */}
            <div style={{ marginTop: '20px' }}>
              <h4 style={styles.sectionTitle}>حالات جهات الاتصال</h4>
              <div style={styles.emptyStatus}>
                <Clock size={36} color="var(--text-muted)" />
                <p style={{ fontSize: '13px', marginTop: '10px' }}>لا توجد حالات نشطة حالياً لدى أصدقائك.</p>
              </div>
            </div>
          </div>
        </div>
      ) : activeChat ? (
        /* واجهة المحادثة النشطة (Active chat area) */
        <div 
          style={{
            ...styles.chatWindow,
            display: isMobile && !activeChat ? 'none' : 'flex',
            width: isMobile ? '100%' : 'auto'
          }} 
          className="glass-panel"
        >
          <div style={{
            ...styles.chatHeader,
            padding: isMobile ? '8px 12px' : '14px 20px'
          }}>
            <div style={{ ...styles.chatHeaderLeft, overflow: 'hidden', flex: 1 }}>
              {isMobile && (
                <button 
                  onClick={() => setActiveChat(null)} 
                  style={{ ...styles.iconBtn, marginLeft: '8px', padding: '4px' }}
                  id="chat-back-btn"
                >
                  <ArrowRight size={22} color="white" />
                </button>
              )}
              <div style={styles.chatAvatarWrapper}>
                <div style={styles.chatAvatar}>
                  <User size={20} color="white" />
                </div>
                {onlineUsers[activeChat.user_id] && <div style={styles.onlineDot} />}
              </div>
              <div style={{ marginRight: '10px', minWidth: '0', flex: 1, overflow: 'hidden' }}>
                <h3 style={{
                  ...styles.chatHeaderText,
                  fontSize: isMobile ? '14px' : '16px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: isMobile ? '140px' : 'none'
                }}>{activeChat.name}</h3>
                <p style={{
                  ...styles.chatHeaderSub,
                  fontSize: isMobile ? '10px' : '11.5px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  maxWidth: isMobile ? '140px' : 'none'
                }}>
                  {onlineUsers[activeChat.user_id] 
                    ? 'متصل الآن' 
                    : `آخر ظهور ${new Date(activeChat.last_seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                </p>
              </div>
            </div>

            {/* أزرار الاتصال الصوتي والمرئي */}
            <div style={styles.chatHeaderActions}>
              <button 
                onClick={() => onInitiateCall(activeChat.user_id, activeChat.name, 'audio', activeChat.conversation_id)} 
                style={styles.callIconBtn}
                title="مكالمة صوتية مشفرة"
                id="voice-call-trigger"
              >
                <Phone size={19} color="#00a884" />
              </button>
              <button 
                onClick={() => onInitiateCall(activeChat.user_id, activeChat.name, 'video', activeChat.conversation_id)} 
                style={styles.callIconBtn}
                title="مكالمة فيديو مشفرة"
                id="video-call-trigger"
              >
                <Video size={19} color="#00a884" />
              </button>
            </div>
          </div>

          {/* تنويه التشفير من طرف لطرف */}
          <div style={{
            ...styles.encryptionNotice,
            backgroundColor: isSecureContext ? 'rgba(11, 20, 26, 0.6)' : 'rgba(234, 0, 56, 0.15)',
            borderBottom: isSecureContext ? '1px solid var(--border-color)' : '1px solid rgba(234, 0, 56, 0.2)'
          }}>
            <ShieldCheck size={16} color={isSecureContext ? '#00a884' : '#ff4d6d'} style={{ marginLeft: '8px' }} />
            <span>
              {isSecureContext 
                ? "الرسائل مشفرة بالكامل من الطرف إلى الطرف (E2EE). لا أحد خارج هذه المحادثة يمكنه قراءتها."
                : "⚠️ وضع التوافق المحلي نشط. لتفعيل التشفير الحقيقي (AES-GCM)، يرجى تشغيل الموقع عبر localhost أو استخدام رابط HTTPS."}
            </span>
          </div>

          {/* منطقة عرض الرسائل */}
          <div style={styles.messagesArea}>
            {derivingKey ? (
              <div style={styles.derivingLoader}>
                <div className="typing-dot" style={{ margin: '0 4px' }} />
                <div className="typing-dot" style={{ margin: '0 4px' }} />
                <div className="typing-dot" style={{ margin: '0 4px' }} />
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '8px' }}>جاري التحقق من أمن القناة واشتقاق مفتاح التشفير...</p>
              </div>
            ) : messages.length === 0 ? (
              <div style={styles.emptyMessages}>
                <p style={{ backgroundColor: 'rgba(0,0,0,0.2)', padding: '6px 14px', borderRadius: '8px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  بدء المحادثة الآمنة. أرسل رسالة ترحيبية!
                </p>
              </div>
            ) : (
              messages.map((msg) => {
                const isMyMessage = msg.sender_id === myUser.id;
                
                return (
                  <div 
                    key={msg.id}
                    style={{ 
                      display: 'flex', 
                      justifyContent: isMyMessage ? 'flex-end' : 'flex-start',
                      width: '100%',
                      marginBottom: '8px'
                    }}
                  >
                    <div 
                      className={`msg-bubble ${isMyMessage ? 'msg-incoming' : 'msg-outgoing'}`}
                    >
                      {msg.message_type === 'call_log' ? (
                        /* رسائل سجل المكالمات */
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ff9f1c', fontWeight: '500' }}>
                          <Phone size={16} />
                          <span>{msg.decrypted_content}</span>
                        </div>
                      ) : msg.message_type === 'media' ? (
                        /* إذا كان الملف وسائط (صورة مشفرة مثلاً) */
                        msg.decrypted_content.startsWith('data:image') ? (
                          <img src={msg.decrypted_content} alt="مرفق مشفر" style={styles.mediaImage} />
                        ) : (
                          <div style={styles.docAttachment}>
                            <Image size={24} style={{ marginLeft: '10px' }} />
                            <span>مرفق مشفر</span>
                          </div>
                        )
                      ) : (
                        /* رسالة نصية عادية */
                        <p>{msg.decrypted_content}</p>
                      )}
                      
                      <div style={styles.msgMeta}>
                        <span style={styles.msgTime}>
                          {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {isMyMessage && (
                          <CheckCheck size={14} color={msg.status === 'read' ? '#53bdeb' : '#8696a0'} style={{ marginRight: '4px' }} />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* منطقة إدخال الرسائل */}
          <form onSubmit={handleSendMessage} style={styles.inputArea}>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              style={{ display: 'none' }}
              accept="image/*,application/pdf"
            />
            <button 
              type="button" 
              onClick={() => fileInputRef.current?.click()} 
              style={styles.chatActionBtn}
              title="إرفاق ملف مشفر"
              id="file-attach-btn"
            >
              <Image size={22} color="var(--text-secondary)" />
            </button>
            
            <input 
              type="text" 
              placeholder="اكتب رسالة مشفرة..."
              value={inputText}
              onChange={handleInputChange}
              style={styles.chatInput}
              id="chat-text-input"
            />

            <button type="submit" style={styles.sendBtn} id="send-msg-btn">
              <Send size={18} color="white" style={{ transform: 'rotate(180deg)' }} />
            </button>
          </form>

        </div>
      ) : !isMobile ? (
        /* واجهة البدء عند عدم اختيار أي محادثة */
        <div style={styles.chatWindowEmpty}>
          <div style={styles.emptyWelcomeCard}>
            <ShieldCheck size={72} color="#00a884" style={{ marginBottom: '20px' }} />
            <h2 style={{ fontSize: '24px', fontWeight: '700', marginBottom: '8px' }}>تطبيق المحادثة الآمن E2EE</h2>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '400px', lineHeight: '1.6' }}>
              اختر جهة اتصال من اللوحة الجانبية لبدء تشفير المحادثات محلياً. جميع الاتصالات مشفرة برمجياً ولا يمكن للسيرفرات اعتراضها.
            </p>
          </div>
        </div>
      ) : null}

    </div>
  );
}

const styles = {
  dashboardContainer: {
    display: 'flex',
    width: '100vw',
    height: '100%',
    backgroundColor: '#0b141a',
    padding: '20px',
    gap: '20px',
    boxSizing: 'border-box',
  },
  sidebar: {
    width: '30%',
    minWidth: '340px',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  profileHeader: {
    padding: '16px',
    borderBottom: '1px solid var(--border-color)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  profileInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  avatar: {
    width: '42px',
    height: '42px',
    borderRadius: '50%',
    backgroundColor: '#00a884',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileName: {
    fontSize: '15px',
    fontWeight: '600',
    color: 'var(--text-primary)',
  },
  profilePhone: {
    fontSize: '11px',
    color: 'var(--text-secondary)',
  },
  iconBtn: {
    backgroundColor: 'transparent',
    padding: '8px',
    borderRadius: '50%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    transition: 'var(--transition)',
  },
  searchSection: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-color)',
  },
  searchForm: {
    display: 'flex',
    gap: '8px',
  },
  searchInput: {
    flex: 1,
    padding: '10px 14px',
    backgroundColor: 'rgba(255,255,255,0.05)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'var(--text-primary)',
    fontSize: '13px',
  },
  searchBtn: {
    backgroundColor: 'var(--primary)',
    padding: '10px 12px',
    borderRadius: '8px',
  },
  searchResultCard: {
    marginTop: '12px',
    padding: '10px 12px',
    backgroundColor: 'rgba(0,168,132,0.1)',
    border: '1px solid rgba(0,168,132,0.2)',
    borderRadius: '8px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  addBtn: {
    backgroundColor: 'var(--primary)',
    color: 'white',
    padding: '6px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: '600',
    display: 'flex',
    alignItems: 'center',
  },
  pendingBadge: {
    fontSize: '11px',
    color: 'var(--text-secondary)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    padding: '4px 10px',
    borderRadius: '6px',
  },
  acceptBtn: {
    backgroundColor: '#00a884',
    color: 'white',
    padding: '6px 10px',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: '600',
  },
  acceptedBadge: {
    fontSize: '11px',
    color: '#00a884',
    fontWeight: '600',
  },
  searchErrorText: {
    fontSize: '12px',
    color: '#ff4d6d',
    marginTop: '8px',
    textAlign: 'center',
  },
  requestsSection: {
    padding: '12px 16px',
    borderBottom: '1px solid var(--border-color)',
  },
  sectionTitle: {
    fontSize: '12.5px',
    fontWeight: '700',
    color: 'var(--primary)',
    marginBottom: '10px',
    letterSpacing: '0.5px',
  },
  requestsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    maxHeight: '120px',
    overflowY: 'auto',
  },
  requestItem: {
    padding: '8px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  circleAcceptBtn: {
    width: '26px',
    height: '26px',
    borderRadius: '50%',
    backgroundColor: '#00a884',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  circleRejectBtn: {
    width: '26px',
    height: '26px',
    borderRadius: '50%',
    backgroundColor: 'var(--accent-reject)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  chatsListSection: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '16px 0 0 0',
  },
  chatsContainer: {
    flex: 1,
    overflowY: 'auto',
  },
  emptyChats: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    padding: '40px 20px',
    color: 'var(--text-secondary)',
  },
  chatItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 16px',
    cursor: 'pointer',
    transition: 'var(--transition)',
    borderBottom: '1px solid rgba(255,255,255,0.02)',
  },
  chatAvatarWrapper: {
    position: 'relative',
    display: 'flex',
  },
  chatAvatar: {
    width: '46px',
    height: '46px',
    borderRadius: '50%',
    backgroundColor: '#202c33',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  onlineDot: {
    position: 'absolute',
    bottom: '2px',
    left: '2px',
    width: '11px',
    height: '11px',
    borderRadius: '50%',
    backgroundColor: '#00a884',
    border: '2px solid var(--bg-sidebar)',
  },
  chatInfo: {
    flex: 1,
    marginRight: '14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    overflow: 'hidden',
  },
  chatInfoTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chatName: {
    fontSize: '14.5px',
    fontWeight: '600',
    color: 'var(--text-primary)',
  },
  chatTime: {
    fontSize: '11px',
    color: 'var(--text-muted)',
  },
  chatInfoBottom: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMessageText: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '220px',
  },
  typingText: {
    fontSize: '13px',
    color: '#00a884',
    fontWeight: '600',
  },
  chatWindow: {
    flex: 1,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: 'var(--bg-chat)',
  },
  chatWindowEmpty: {
    flex: 1,
    height: '100%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f181f',
    borderRadius: 'var(--radius)',
    border: '1px solid var(--border-color)',
  },
  emptyWelcomeCard: {
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '20px',
  },
  chatHeader: {
    padding: '14px 20px',
    backgroundColor: 'var(--bg-sidebar)',
    borderBottom: '1px solid var(--border-color)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexShrink: 0, // يمنع اختفاء الترويسة أو تقلصها على شاشات الهواتف
  },
  chatHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
  },
  chatHeaderText: {
    fontSize: '16px',
    fontWeight: '700',
    color: 'var(--text-primary)',
  },
  chatHeaderSub: {
    fontSize: '11.5px',
    color: 'var(--text-secondary)',
  },
  chatHeaderActions: {
    display: 'flex',
    gap: '12px',
  },
  callIconBtn: {
    backgroundColor: 'rgba(0,168,132,0.1)',
    width: '38px',
    height: '38px',
    borderRadius: '50%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    transition: 'var(--transition)',
  },
  encryptionNotice: {
    backgroundColor: 'rgba(11, 20, 26, 0.6)',
    padding: '8px 16px',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    fontSize: '11px',
    color: 'var(--text-secondary)',
    borderBottom: '1px solid var(--border-color)',
    textAlign: 'center',
    flexShrink: 0, // يمنع تقلص لوحة التنبيه
  },
  messagesArea: {
    flex: 1,
    padding: '20px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    backgroundImage: 'radial-gradient(circle at 10% 20%, rgba(0, 168, 132, 0.05) 0%, transparent 90%)',
  },
  derivingLoader: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
  },
  emptyMessages: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
  },
  msgMeta: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    fontSize: '9.5px',
    color: 'rgba(255,255,255,0.5)',
    marginTop: '4px',
  },
  msgTime: {
    fontSize: '9.5px',
  },
  inputArea: {
    padding: '12px 20px',
    backgroundColor: 'var(--bg-sidebar)',
    borderTop: '1px solid var(--border-color)',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexShrink: 0, // يمنع تقلص منطقة الكتابة عند فتح لوحة المفاتيح
  },
  chatActionBtn: {
    backgroundColor: 'transparent',
    padding: '6px',
  },
  chatInput: {
    flex: 1,
    padding: '12px 18px',
    backgroundColor: 'rgba(255,255,255,0.05)',
    border: '1px solid var(--border-color)',
    borderRadius: '24px',
    color: 'var(--text-primary)',
    fontSize: '14px',
  },
  sendBtn: {
    backgroundColor: 'var(--primary)',
    width: '42px',
    height: '42px',
    borderRadius: '50%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: '0 2px 8px var(--primary-glow)',
  },
  mediaImage: {
    maxWidth: '260px',
    maxHeight: '260px',
    borderRadius: '8px',
    display: 'block',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
  },
  docAttachment: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px',
    borderRadius: '6px',
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  statusContent: {
    padding: '20px',
    flex: 1,
    overflowY: 'auto',
  },
  statusCreateCard: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  statusInput: {
    width: '100%',
    height: '80px',
    padding: '12px',
    backgroundColor: 'rgba(0,0,0,0.2)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    color: 'white',
    resize: 'none',
    fontSize: '13.5px',
  },
  statusPublishBtn: {
    alignSelf: 'flex-end',
    backgroundColor: 'var(--primary)',
    color: 'white',
    padding: '8px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: '600',
    display: 'flex',
    alignItems: 'center',
  },
  emptyStatus: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '40px',
    color: 'var(--text-secondary)',
    textAlign: 'center',
  }
};

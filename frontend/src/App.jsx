import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Auth from './components/Auth';
import Dashboard from './components/Dashboard';
import CallModal from './components/CallModal';

// جلب عنوان السيرفر من متغيرات البيئة أو التحويل التلقائي لرابط Render عند التشغيل أونلاين
const getBackendUrl = () => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  // إذا كان الموقع يعمل عبر بروتوكول آمن HTTPS وليس محلياً، نربطه تلقائياً برابط الـ Render الخاص بك
  if (window.location.protocol === 'https:' && !window.location.hostname.includes('localhost')) {
    return 'https://whatsapp-zaid.onrender.com';
  }
  return `http://${window.location.hostname}:5000`;
};

const SERVER_URL = getBackendUrl();

// خوادم STUN العامة من غوغل لحل مشاكل الـ NAT والاتصال عبر الإنترنت
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('auth_token'));
  const [user, setUser] = useState(null);
  const [socket, setSocket] = useState(null);
  
  // مراجع أجهزة الصوت والاتصال بالـ WebRTC
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // نظام الاتصالات والمكالمات
  const [callInfo, setCallInfo] = useState({
    isActive: false,
    isIncoming: false,
    callerId: '',
    callerName: '',
    callType: 'audio', // audio or video
    status: 'idle', // idle, ringing, active
    conversationId: '',
    offer: null
  });

  const [socketConnected, setSocketConnected] = useState(false);

  // 1. استرجاع معلومات المستخدم الحالي
  useEffect(() => {
    if (token) {
      localStorage.setItem('auth_token', token);
      fetchUserInfo();
    } else {
      localStorage.removeItem('auth_token');
      setUser(null);
    }
  }, [token]);

  // 2. إعداد اتصال الـ WebSockets واستقبل إشارات WebRTC
  useEffect(() => {
    if (!token) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setSocketConnected(false);
      }
      return;
    }

    // السماح بكل من polling و websocket لضمان استقرار الاتصال تحت أي جدار حماية
    const newSocket = io(SERVER_URL, {
      auth: { token },
      transports: ['polling', 'websocket']
    });

    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('✅ Socket connected successfully!');
      setSocketConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.warn('❌ Socket disconnected!');
      setSocketConnected(false);
    });

    // استقبال رنين مكالمة واردة (Incoming Call Signal)
    newSocket.on('incoming_call', (data) => {
      setCallInfo({
        isActive: true,
        isIncoming: true,
        callerId: data.caller_id,
        callerName: data.caller_name,
        callType: data.call_type,
        status: 'ringing',
        conversationId: data.conversation_id,
        offer: data.offer // حفظ العرض المستلم (WebRTC Offer)
      });
    });

    // استجابة الطرف الآخر وقبوله للمكالمة (Call Answered Signal)
    newSocket.on('call_answered', async (data) => {
      setCallInfo((prev) => ({ ...prev, status: 'active' }));
      if (pcRef.current) {
        try {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (err) {
          console.error("Failed to set remote description on answer:", err);
        }
      }
    });

    // تبادل مرشحي الاتصال (ICE Candidates)
    newSocket.on('ice_candidate', async (data) => {
      if (pcRef.current) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.warn("Failed to add ICE candidate:", err);
        }
      }
    });

    // إنهاء المكالمة من الطرف الآخر (Call Ended Signal)
    newSocket.on('call_ended', () => {
      resetCallState();
    });

    newSocket.on('connect_error', (err) => {
      console.warn('Socket connection error:', err.message);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [token]);

  const fetchUserInfo = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setUser(data.user);
      } else {
        setToken(null);
      }
    } catch (err) {
      console.error(err);
      setToken(null);
    }
  };

  const handleAuthSuccess = (newToken, authenticatedUser) => {
    setToken(newToken);
    setUser(authenticatedUser);
  };

  const handleLogout = () => {
    if (socket) socket.disconnect();
    localStorage.removeItem('auth_token');
    setToken(null);
    setUser(null);
  };

  // 3. تشغيل تدفق الصوت/الفيديو المحلي (GetUserMedia)
  const startLocalStream = async (type) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("SECURE_CONTEXT_REQUIRED");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video'
    });
    localStreamRef.current = stream;
    return stream;
  };

  // 4. إنشاء وتهيئة اتصال WebRTC (Setup WebRTC Connection)
  const setupPeerConnection = (targetUserId, type) => {
    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;

    // إضافة التراكات المحلية للاتصال المشترك
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // إرسال مرشحي الشبكة المحليين (ICE Candidates) للطرف الآخر
    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('ice_candidate', {
          target_id: targetUserId,
          candidate: event.candidate
        });
      }
    };

    // استقبال الصوت/الفيديو من الطرف الآخر وتشغيله فوراً
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (!remoteAudioRef.current) {
        const audio = new Audio();
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        audio.play().catch(e => console.warn("Autoplay blocked or failed:", e));
        remoteAudioRef.current = audio;
      } else {
        remoteAudioRef.current.srcObject = remoteStream;
      }
    };

    return pc;
  };

  // 5. إجراء مكالمة (صادرة)
  const initiateCall = async (targetUserId, targetName, type, conversationId) => {
    if (!socket) return;

    try {
      // 1. طلب صلاحيات الميكروفون/الكاميرا محلياً
      const stream = await startLocalStream(type);
      
      setCallInfo({
        isActive: true,
        isIncoming: false,
        callerId: targetUserId,
        callerName: targetName,
        callType: type,
        status: 'ringing',
        conversationId,
        offer: null
      });

      // 2. إنشاء اتصال الـ WebRTC
      const pc = setupPeerConnection(targetUserId, type);
      
      // 3. إنشاء العرض (WebRTC Offer) وإرساله
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit('call_user', {
        receiver_id: targetUserId,
        call_type: type,
        offer: offer,
        conversation_id: conversationId
      });

    } catch (err) {
      console.error("Failed to start local WebRTC session:", err);
      if (err.message === "SECURE_CONTEXT_REQUIRED") {
        alert("🔒 عذراً، المتصفح يحظر الوصول للميكروفون والكاميرا عبر روابط HTTP غير الآمنة. يرجى تشغيل الموقع عبر رابط HTTPS مشفر (مثل رابط ngrok المشفر) لتتمكن من إجراء المكالمات.");
      } else {
        alert("تعذر تشغيل الميكروفون أو الكاميرا لبدء المكالمة.");
      }
      resetCallState();
    }
  };

  // 6. قبول المكالمة (الواردة)
  const acceptCall = async () => {
    if (!socket || !callInfo.offer) return;

    try {
      // 1. تشغيل الميكروفون/الكاميرا للرد
      const stream = await startLocalStream(callInfo.callType);
      
      setCallInfo((prev) => ({ ...prev, status: 'active' }));

      // 2. إنشاء وتجهيز اتصال الـ WebRTC
      const pc = setupPeerConnection(callInfo.callerId, callInfo.callType);
      
      // 3. قبول العرض المستلم من المتصل
      await pc.setRemoteDescription(new RTCSessionDescription(callInfo.offer));

      // 4. إنشاء الرد (WebRTC Answer) وإرساله للمتصل للربط النهائي
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer_call', {
        caller_id: callInfo.callerId,
        answer: answer
      });

    } catch (err) {
      console.error("Failed to accept WebRTC session:", err);
      if (err.message === "SECURE_CONTEXT_REQUIRED") {
        alert("🔒 عذراً، المتصفح يحظر تشغيل الميكروفون والكاميرا عبر روابط HTTP غير الآمنة. يرجى فتح رابط الـ HTTPS المشفر للرد على المكالمة.");
      } else {
        alert("حدث خطأ أثناء الاتصال بجهاز الصوت.");
      }
      rejectCall();
    }
  };

  // 7. رفض المكالمة (الواردة)
  const rejectCall = () => {
    if (socket) {
      socket.emit('end_call', { target_id: callInfo.callerId });
    }
    resetCallState();
  };

  // 8. إنهاء المكالمة النشطة
  const endActiveCall = () => {
    if (socket) {
      socket.emit('end_call', { target_id: callInfo.callerId });
    }
    resetCallState();
  };

  // 9. تنظيف الأجهزة وإغلاق الاتصالات (Cleanup WebRTC Session)
  const resetCallState = () => {
    // إيقاف بث الميكروفون والكاميرا وإطفاء الضوء الأخضر
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    // إغلاق اتصال WebRTC
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    // إيقاف مشغل الصوت عن بعد
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current = null;
    }

    setCallInfo({
      isActive: false,
      isIncoming: false,
      callerId: '',
      callerName: '',
      callType: 'audio',
      status: 'idle',
      conversationId: '',
      offer: null
    });
  };

  if (!token || !user) {
    return <Auth onAuthSuccess={handleAuthSuccess} serverUrl={SERVER_URL} />;
  }

  return (
    <div style={{ width: '100vw', height: '100%', display: 'flex' }} id="app-wrapper">
      <Dashboard 
        token={token} 
        myUser={user} 
        socket={socket} 
        socketConnected={socketConnected}
        serverUrl={SERVER_URL} 
        onLogout={handleLogout}
        onInitiateCall={initiateCall}
      />

      {callInfo.isActive && (
        <CallModal 
          callInfo={callInfo} 
          onAccept={acceptCall} 
          onReject={rejectCall} 
          onEndCall={endActiveCall}
        />
      )}
    </div>
  );
}

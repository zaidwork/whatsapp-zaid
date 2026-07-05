import React, { useState, useEffect, useRef } from 'react';
import { Phone, PhoneOff, Video, Mic, MicOff, VideoOff, Volume2, VolumeX } from 'lucide-react';

export default function CallModal({ 
  callInfo, 
  localStream, 
  remoteStream, 
  micActive, 
  videoActive, 
  onToggleMic, 
  onToggleVideo, 
  onAccept, 
  onReject, 
  onEndCall 
}) {
  const { isIncoming, callerName, callType, status } = callInfo;

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  // ربط تدفق الفيديو المحلي عند توفره
  useEffect(() => {
    if (localVideoRef.current && localStream && videoActive) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, videoActive, status]);

  // ربط تدفق فيديو الطرف الآخر عند توفره
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, status]);

  const [speakerActive, setSpeakerActive] = useState(false);

  // تشغيل/إيقاف مكبر الصوت (Speakerphone)
  const toggleSpeaker = async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
      
      // التبديل بين المخرج الافتراضي للـ earpiece والمخرج الثاني (المكبر)
      const targetSinkId = speakerActive ? '' : (audioOutputs[1]?.deviceId || audioOutputs[0]?.deviceId || '');
      
      const mediaElements = document.querySelectorAll('audio, video');
      for (const media of mediaElements) {
        if (typeof media.setSinkId === 'function') {
          await media.setSinkId(targetSinkId);
        }
      }
      setSpeakerActive(!speakerActive);
      console.log("Speaker toggled. Active:", !speakerActive);
    } catch (err) {
      console.warn("Failed to toggle speaker:", err);
    }
  };

  return (
    <div style={styles.overlay} className="animate-fade-in" id="call-modal">
      <div style={styles.modal} className="glass-panel">
        
        {/* رأس المكالمة وجسمها */}
        <div style={styles.body}>
          <div 
            style={styles.avatarContainer} 
            className={status === 'ringing' ? (isIncoming ? 'pulse-primary' : 'pulse-primary') : ''}
          >
            {callType === 'video' ? (
              <Video size={48} color="#00a884" />
            ) : (
              <Phone size={48} color="#00a884" />
            )}
          </div>
          
          <h2 style={styles.callerName}>{callerName || 'جهة اتصال مجهولة'}</h2>
          
          <p style={styles.statusText}>
            {status === 'ringing' 
              ? (isIncoming ? 'مكالمة واردة...' : 'جاري الاتصال والرنين...') 
              : 'مكالمة نشطة الآن'}
          </p>
          
          <span style={styles.badge}>
            {callType === 'video' ? 'فيديو مشفر' : 'مكالمة صوتية مشفرة'}
          </span>
        </div>

        {/* مساحة عرض البث المباشر في حال مكالمة الفيديو النشطة */}
        {callType === 'video' && status === 'active' && (
          <div style={styles.videoGrid} id="video-streams">
            {/* كاميرا الطرف الآخر */}
            <div style={styles.remoteVideo}>
              {remoteStream ? (
                <video 
                  ref={remoteVideoRef} 
                  autoPlay 
                  playsInline 
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                />
              ) : (
                <div style={styles.videoPlaceholder}>
                  <Video size={36} color="var(--text-secondary)" />
                  <p style={{ fontSize: '12px', marginTop: '6px' }}>بث الطرف الآخر</p>
                </div>
              )}
            </div>
            {/* كاميرتك المحلية (صغيرة) */}
            <div style={styles.localVideo}>
              {videoActive && localStream ? (
                <video 
                  ref={localVideoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                />
              ) : (
                <VideoOff size={16} color="white" />
              )}
            </div>
          </div>
        )}

        {/* لوحة أزرار التحكم */}
        <div style={styles.actions}>
          {status === 'ringing' && isIncoming ? (
            /* في حال مكالمة واردة ورنين */
            <div style={styles.ringingButtons}>
              <button 
                onClick={onAccept} 
                style={{ ...styles.actionBtn, backgroundColor: 'var(--primary)' }}
                id="accept-call-btn"
                title="قبول المكالمة"
              >
                <Phone size={24} color="white" />
              </button>
              <button 
                onClick={onReject} 
                style={{ ...styles.actionBtn, backgroundColor: 'var(--accent-reject)' }}
                id="reject-call-btn"
                title="رفض"
              >
                <PhoneOff size={24} color="white" />
              </button>
            </div>
          ) : (
            /* في حال مكالمة نشطة أو مكالمة خارج رنين الصادر */
            <div style={styles.activeButtons}>
              {status === 'active' && (
                <>
                  <button 
                    onClick={onToggleMic} 
                    style={{ ...styles.controlBtn, backgroundColor: micActive ? 'rgba(255,255,255,0.1)' : 'rgba(234,0,56,0.2)' }}
                    id="mute-mic-btn"
                    title={micActive ? "كتم الميكروفون" : "تشغيل الميكروفون"}
                  >
                    {micActive ? <Mic size={20} color="white" /> : <MicOff size={20} color="#ff4d6d" />}
                  </button>
                  
                  <button 
                    onClick={toggleSpeaker} 
                    style={{ ...styles.controlBtn, backgroundColor: speakerActive ? 'rgba(0,168,132,0.2)' : 'rgba(255,255,255,0.1)' }}
                    id="toggle-speaker-btn"
                    title={speakerActive ? "تعطيل مكبر الصوت" : "تشغيل مكبر الصوت"}
                  >
                    {speakerActive ? <Volume2 size={20} color="#00a884" /> : <VolumeX size={20} color="white" />}
                  </button>

                  {callType === 'video' && (
                    <button 
                      onClick={onToggleVideo} 
                      style={{ ...styles.controlBtn, backgroundColor: videoActive ? 'rgba(255,255,255,0.1)' : 'rgba(234,0,56,0.2)' }}
                      id="toggle-video-btn"
                      title={videoActive ? "إيقاف الكاميرا" : "تشغيل الكاميرا"}
                    >
                      {videoActive ? <Video size={20} color="white" /> : <VideoOff size={20} color="#ff4d6d" />}
                    </button>
                  )}
                </>
              )}
              <button 
                onClick={onEndCall} 
                style={{ ...styles.actionBtn, backgroundColor: 'var(--accent-reject)', width: '60px', height: '60px' }}
                id="end-call-btn"
                title="إنهاء المكالمة"
              >
                <PhoneOff size={24} color="white" />
              </button>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    backgroundColor: 'rgba(11, 20, 26, 0.9)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
    padding: '20px',
  },
  modal: {
    width: '100%',
    maxWidth: '400px',
    backgroundColor: '#111b21',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: '24px',
    padding: '30px 20px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5)',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    marginBottom: '24px',
  },
  avatarContainer: {
    width: '110px',
    height: '110px',
    borderRadius: '50%',
    backgroundColor: 'rgba(0, 168, 132, 0.1)',
    border: '2px solid rgba(0, 168, 132, 0.3)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: '20px',
  },
  callerName: {
    fontSize: '22px',
    fontWeight: '700',
    color: '#e9edef',
    marginBottom: '6px',
  },
  statusText: {
    fontSize: '14px',
    color: '#8696a0',
    marginBottom: '12px',
  },
  badge: {
    fontSize: '11px',
    fontWeight: '600',
    backgroundColor: 'rgba(0, 168, 132, 0.2)',
    color: '#00a884',
    padding: '4px 12px',
    borderRadius: '20px',
    border: '1px solid rgba(0, 168, 132, 0.3)',
  },
  videoGrid: {
    width: '100%',
    height: '180px',
    position: 'relative',
    borderRadius: '16px',
    overflow: 'hidden',
    backgroundColor: '#0b141a',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    marginBottom: '24px',
  },
  remoteVideo: {
    width: '100%',
    height: '100%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoPlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    color: 'var(--text-secondary)',
  },
  localVideo: {
    position: 'absolute',
    bottom: '10px',
    left: '10px',
    width: '60px',
    height: '80px',
    borderRadius: '8px',
    backgroundColor: '#202c33',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  localVideoPlaceholder: {
    fontSize: '10px',
    color: '#8696a0',
  },
  actions: {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
  },
  ringingButtons: {
    display: 'flex',
    gap: '40px',
  },
  activeButtons: {
    display: 'flex',
    alignItems: 'center',
    gap: '20px',
  },
  actionBtn: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
    transition: 'all 0.2s',
  },
  controlBtn: {
    width: '46px',
    height: '46px',
    borderRadius: '50%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    transition: 'all 0.2s',
    border: '1px solid rgba(255,255,255,0.05)',
  }
};

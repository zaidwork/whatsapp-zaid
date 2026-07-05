let audioCtx = null;
let ringtoneInterval = null;

/**
 * تشغيل نغمة الرنين ديناميكياً باستخدام Web Audio API المدمجة بالمتصفح
 * @param {boolean} isIncoming - إذا كانت المكالمة واردة تشغل رنين هاتف، وإذا كانت صادرة تشغل رنين اتصال (ringback)
 */
export function startRingtone(isIncoming) {
  stopRingtone();

  const playTone = (freq1, freq2, duration) => {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      const osc1 = audioCtx.createOscillator();
      const osc2 = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.value = freq1;
      osc2.frequency.value = freq2;

      // إعداد حركات مستوى الصوت لتجنب الخشخشة عند بدء ووقف النغمة
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.15, audioCtx.currentTime + 0.05);
      gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime + duration - 0.05);
      gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + duration);

      osc1.connect(gainNode);
      osc2.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      osc1.start();
      osc2.start();
      osc1.stop(audioCtx.currentTime + duration);
      osc2.stop(audioCtx.currentTime + duration);
    } catch (e) {
      console.warn("Web Audio ringtone failed to start:", e);
    }
  };

  if (isIncoming) {
    // مكالمة واردة: رنين ثنائي متكرر (Cadence: 0.4s ring, 0.2s pause, 0.4s ring, repeat after 3s)
    const ringSequence = () => {
      playTone(400, 450, 0.4);
      setTimeout(() => {
        playTone(400, 450, 0.4);
      }, 600);
    };
    ringSequence();
    ringtoneInterval = setInterval(ringSequence, 3000);
  } else {
    // مكالمة صادرة: رنة اتصال طويلة (Cadence: 1.5s ring, repeat after 4s)
    const ringback = () => {
      playTone(440, 480, 1.5);
    };
    ringback();
    ringtoneInterval = setInterval(ringback, 4000);
  }
}

/**
 * إيقاف تشغيل نغمة الرنين فوراً وتنظيف المؤقت
 */
export function stopRingtone() {
  if (ringtoneInterval) {
    clearInterval(ringtoneInterval);
    ringtoneInterval = null;
  }
}

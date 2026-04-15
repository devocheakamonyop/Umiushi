/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Square, Mic, Volume2, Info, Settings2 } from 'lucide-react';
import { AudioEngine, AudioEngineConfig } from './lib/audioEngine';

export default function App() {
  const [isActive, setIsActive] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [config, setConfig] = useState<AudioEngineConfig>({
    bpm: 120,
    rhythmPattern: 'tresillo',
    edo: 12,
    fmIndex: 1.5,
    reverbMix: 0.5,
    droneLevel: 1.0,
    noiseLevel: 1.0,
    sensitivity: 1.0,
    trackingProb: 0.75,
    duckingDepth: 15,
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AudioEngine | null>(null);
  const animationRef = useRef<number | null>(null);

  const fetchDevices = async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices.filter(d => d.kind === 'audioinput');
      setDevices(audioInputs);
      if (audioInputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(audioInputs[0].deviceId);
      }
    } catch (err) {
      console.error("Failed to enumerate devices:", err);
    }
  };

  useEffect(() => {
    fetchDevices();
    navigator.mediaDevices.addEventListener('devicechange', fetchDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', fetchDevices);
  }, []);

  const startEngine = async () => {
    if (!engineRef.current) {
      engineRef.current = new AudioEngine();
      engineRef.current.updateConfig(config);
    }
    await engineRef.current.init(selectedDeviceId);
    setIsActive(true);
    startVisualizer();
    // Re-fetch devices to get labels if they were empty before permission
    fetchDevices();
  };

  const handleDeviceChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value;
    setSelectedDeviceId(newId);
    if (isActive && engineRef.current) {
      await engineRef.current.setDevice(newId);
    }
  };

  const stopEngine = () => {
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
    }
    setIsActive(false);
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
  };

  const updateConfig = (key: keyof AudioEngineConfig, value: any) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    if (engineRef.current) {
      engineRef.current.updateConfig(newConfig);
    }
  };

  const startVisualizer = () => {
    const canvas = canvasRef.current;
    if (!canvas || !engineRef.current) return;

    const ctx = canvas.getContext('2d');
    const analyser = engineRef.current.getAnalyser();
    if (!ctx || !analyser) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.fillStyle = 'rgba(10, 10, 10, 0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 2;

        const r = barHeight + (25 * (i / bufferLength));
        const g = 250 * (i / bufferLength);
        const b = 50;

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

        x += barWidth + 1;
      }

      // Draw some ethereal particles or lines for the "harmonic" part
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.beginPath();
      ctx.moveTo(0, canvas.height / 2);
      for (let i = 0; i < bufferLength; i += 10) {
        const y = (canvas.height / 2) + Math.sin(i * 0.05 + Date.now() * 0.001) * (dataArray[i] / 4);
        ctx.lineTo((i / bufferLength) * canvas.width, y);
      }
      ctx.stroke();
    };

    draw();
  };

  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="relative min-h-screen bg-[#0a0a0a] text-white font-sans overflow-hidden">
      {/* Background Visualizer */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full opacity-40 pointer-events-none"
      />

      {/* Main UI */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-screen p-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1 }}
          className="text-center mb-12"
        >
          <h1 className="text-4xl md:text-6xl font-display font-light tracking-widest mb-4 uppercase">
            Ambient Harmonic
          </h1>
          <p className="text-sm md:text-base text-gray-400 tracking-[0.3em] uppercase">
            Mobile Installation Synthesizer
          </p>
        </motion.div>

        <div className="flex gap-8 items-center">
          {!isActive ? (
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={startEngine}
              className="w-20 h-20 rounded-full border border-white/20 flex items-center justify-center bg-white/5 hover:bg-white/10 transition-colors"
            >
              <Play className="w-8 h-8 fill-white" />
            </motion.button>
          ) : (
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={stopEngine}
              className="w-20 h-20 rounded-full border border-white/20 flex items-center justify-center bg-white/5 hover:bg-white/10 transition-colors"
            >
              <Square className="w-8 h-8 fill-white" />
            </motion.button>
          )}
        </div>

        {/* Status Indicators */}
        <div className="absolute bottom-12 left-12 flex flex-col gap-4">
          <div className={`flex items-center gap-3 transition-opacity duration-500 ${isActive ? 'opacity-100' : 'opacity-20'}`}>
            <Mic className="w-4 h-4" />
            <span className="text-[10px] tracking-widest uppercase">Sampling Ambient</span>
          </div>
          <div className={`flex items-center gap-3 transition-opacity duration-500 ${isActive ? 'opacity-100' : 'opacity-20'}`}>
            <Volume2 className="w-4 h-4" />
            <span className="text-[10px] tracking-widest uppercase">Modulating {config.edo}-EDO</span>
          </div>
        </div>

        {/* Device Selector */}
        <div className="absolute bottom-12 right-12 flex flex-col items-end gap-2 z-20">
          <label className="text-[10px] tracking-widest uppercase text-gray-400">Audio Source</label>
          <select
            value={selectedDeviceId}
            onChange={handleDeviceChange}
            className="bg-black/50 border border-white/20 text-white text-xs rounded-md px-3 py-2 outline-none focus:border-white/50 transition-colors max-w-[200px] truncate appearance-none cursor-pointer"
          >
            {devices.map((d, index) => (
              <option key={d.deviceId || index} value={d.deviceId}>
                {d.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
        </div>

        {/* Info Toggle */}
        <div className="absolute top-12 right-12 flex gap-4 z-20">
          <button
            onClick={() => { setShowSettings(!showSettings); setShowInfo(false); }}
            className={`p-2 transition-opacity ${showSettings ? 'opacity-100 text-white' : 'opacity-40 hover:opacity-100'}`}
          >
            <Settings2 className="w-6 h-6" />
          </button>
          <button
            onClick={() => { setShowInfo(!showInfo); setShowSettings(false); }}
            className={`p-2 transition-opacity ${showInfo ? 'opacity-100 text-white' : 'opacity-40 hover:opacity-100'}`}
          >
            <Info className="w-6 h-6" />
          </button>
        </div>

        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ opacity: 0, x: 100 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 100 }}
              className="absolute top-24 right-12 w-80 p-6 bg-black/40 backdrop-blur-xl border border-white/10 rounded-2xl text-xs leading-relaxed text-gray-300 z-30 max-h-[70vh] overflow-y-auto custom-scrollbar"
            >
              <h3 className="text-sm font-semibold text-white mb-4 uppercase tracking-widest border-b border-white/10 pb-2">Settings</h3>
              
              <div className="space-y-6">
                {/* Musical & Rhythm */}
                <div className="space-y-4">
                  <h4 className="text-[10px] text-gray-500 uppercase tracking-widest">Musical & Rhythm</h4>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Tempo (BPM)</label>
                      <span>{config.bpm}</span>
                    </div>
                    <input type="range" min="60" max="180" value={config.bpm} onChange={(e) => updateConfig('bpm', Number(e.target.value))} className="w-full accent-white" />
                  </div>

                  <div className="space-y-1">
                    <label className="block">Rhythm Pattern</label>
                    <select value={config.rhythmPattern} onChange={(e) => updateConfig('rhythmPattern', e.target.value)} className="w-full bg-white/5 border border-white/10 rounded p-1 outline-none">
                      <option value="tresillo">Tresillo (Syncopated)</option>
                      <option value="fourOnTheFloor">4-on-the-floor</option>
                      <option value="random">Random</option>
                      <option value="none">None (Reactive only)</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="block">Tuning System (EDO)</label>
                    <select value={config.edo} onChange={(e) => updateConfig('edo', Number(e.target.value))} className="w-full bg-white/5 border border-white/10 rounded p-1 outline-none">
                      <option value="12">12-TET (Standard)</option>
                      <option value="31">31-EDO (Microtonal)</option>
                      <option value="19">19-EDO</option>
                      <option value="24">24-EDO (Quarter tones)</option>
                    </select>
                  </div>
                </div>

                {/* Timbre & Mix */}
                <div className="space-y-4">
                  <h4 className="text-[10px] text-gray-500 uppercase tracking-widest">Timbre & Mix</h4>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Piano Timbre (FM Index)</label>
                      <span>{config.fmIndex.toFixed(1)}</span>
                    </div>
                    <input type="range" min="0" max="3" step="0.1" value={config.fmIndex} onChange={(e) => updateConfig('fmIndex', Number(e.target.value))} className="w-full accent-white" />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Reverb Mix</label>
                      <span>{Math.round(config.reverbMix * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.05" value={config.reverbMix} onChange={(e) => updateConfig('reverbMix', Number(e.target.value))} className="w-full accent-white" />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Drone Level</label>
                      <span>{Math.round(config.droneLevel * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="2" step="0.1" value={config.droneLevel} onChange={(e) => updateConfig('droneLevel', Number(e.target.value))} className="w-full accent-white" />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Noise Level</label>
                      <span>{Math.round(config.noiseLevel * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="2" step="0.1" value={config.noiseLevel} onChange={(e) => updateConfig('noiseLevel', Number(e.target.value))} className="w-full accent-white" />
                  </div>
                </div>

                {/* Interaction */}
                <div className="space-y-4">
                  <h4 className="text-[10px] text-gray-500 uppercase tracking-widest">Interaction</h4>
                  
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Mic Sensitivity</label>
                      <span>{config.sensitivity.toFixed(1)}x</span>
                    </div>
                    <input type="range" min="0.1" max="3" step="0.1" value={config.sensitivity} onChange={(e) => updateConfig('sensitivity', Number(e.target.value))} className="w-full accent-white" />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Pitch Tracking Match %</label>
                      <span>{Math.round(config.trackingProb * 100)}%</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.05" value={config.trackingProb} onChange={(e) => updateConfig('trackingProb', Number(e.target.value))} className="w-full accent-white" />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <label>Ducking Depth (dB)</label>
                      <span>-{config.duckingDepth}dB</span>
                    </div>
                    <input type="range" min="0" max="30" step="1" value={config.duckingDepth} onChange={(e) => updateConfig('duckingDepth', Number(e.target.value))} className="w-full accent-white" />
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {showInfo && (
            <motion.div
              initial={{ opacity: 0, x: 100 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 100 }}
              className="absolute top-24 right-12 w-64 p-6 bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl text-xs leading-relaxed text-gray-300 z-30"
            >
              <p className="mb-4">
                このソフトウェアは、周囲の環境音をリアルタイムで解析し、設定された音律に基づいた和声へと変調します。
              </p>
              <p>
                環境の響きと現代音楽的な和音の境界を探求する「モバイルインスタレーション」です。右上の設定アイコンから各種パラメータをカスタマイズできます。
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Atmospheric Overlays */}
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-black via-transparent to-transparent opacity-60" />
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_50%_50%,rgba(255,255,255,0.05)_0%,transparent_70%)]" />
    </div>
  );
}

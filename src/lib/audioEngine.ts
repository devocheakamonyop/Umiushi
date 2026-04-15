/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AudioEngineConfig {
  bpm: number;
  rhythmPattern: 'tresillo' | 'fourOnTheFloor' | 'random' | 'none';
  edo: number;
  fmIndex: number;
  reverbMix: number;
  droneLevel: number;
  noiseLevel: number;
  sensitivity: number;
  trackingProb: number;
  duckingDepth: number;
}

export class AudioEngine {
  public config: AudioEngineConfig = {
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
  };

  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private masterGain: GainNode | null = null;
  private masterFilter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private duckingFilter: BiquadFilterNode | null = null;
  private masterHighpass: BiquadFilterNode | null = null;
  private masterLowshelf: BiquadFilterNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private oscillators: { osc: OscillatorNode; gain: GainNode; baseFreq: number }[] = [];
  private reverb: ConvolverNode | null = null;
  private currentRootStep = 0; // Track root for parallel chord movements
  private currentInputStep = 0; // Track exact input pitch step
  private baseFreq = 220; // A3
  private lastEnergy = 0;
  private lastChordTime = 0;
  private wasSpeaking = false;
  private dynamicTimeConstant = 0.1;
  private dynamicPulseDecay = 6;
  
  // Rhythm layer properties
  private nextRhythmTime = 0;
  private rhythmStep = 0;
  
  // Stutter effect properties
  private stutterStepsRemaining = 0;
  private stutterSpeed = 1; // 1 = 16th notes, 2 = 32nd notes

  // Piano inner voices for smooth morphing (absolute steps)
  private pianoInnerVoices = [-11, -7, -4];

  // Noise / Glitch layer
  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private noiseGain: GainNode | null = null;

  // Ambient Drone layer
  private ambientSource: AudioBufferSourceNode | null = null;
  private ambientFilter: BiquadFilterNode | null = null;
  private ambientGain: GainNode | null = null;

  constructor() {}

  async init(deviceId?: string) {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.4; // Slightly higher master volume

    // Master Filter for dramatic timbre changes
    this.masterFilter = this.ctx.createBiquadFilter();
    this.masterFilter.type = 'lowpass';
    this.masterFilter.frequency.value = 300; // Muffled when silent
    this.masterFilter.Q.value = 2;

    // Simple Reverb (Impulse Response)
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.createReverbBuffer();
    
    // Drone gain for stutter effect
    this.droneGain = this.ctx.createGain();
    this.droneGain.gain.value = 1.0;
    
    // Ducking filter to carve out space for the input voice
    this.duckingFilter = this.ctx.createBiquadFilter();
    this.duckingFilter.type = 'peaking';
    this.duckingFilter.Q.value = 1.5; // Moderate width
    this.duckingFilter.gain.value = 0;
    
    this.masterFilter.connect(this.droneGain);
    this.droneGain.connect(this.masterGain);
    
    // Route masterGain through duckingFilter before reverb
    this.masterGain.connect(this.duckingFilter);
    
    this.dryGain = this.ctx.createGain();
    this.wetGain = this.ctx.createGain();
    
    this.duckingFilter.connect(this.dryGain);
    this.duckingFilter.connect(this.wetGain);
    
    this.wetGain.connect(this.reverb);

    // Master EQ: Cut below 40Hz, reduce 40-300Hz by ~20% (-2dB)
    this.masterHighpass = this.ctx.createBiquadFilter();
    this.masterHighpass.type = 'highpass';
    this.masterHighpass.frequency.value = 40;
    this.masterHighpass.Q.value = 0.707; // Butterworth response

    this.masterLowshelf = this.ctx.createBiquadFilter();
    this.masterLowshelf.type = 'lowshelf';
    this.masterLowshelf.frequency.value = 300;
    this.masterLowshelf.gain.value = -2.0; // ~20% amplitude reduction

    this.reverb.connect(this.masterHighpass);
    this.dryGain.connect(this.masterHighpass);
    this.masterHighpass.connect(this.masterLowshelf);
    this.masterLowshelf.connect(this.ctx.destination);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.64; // Reduced from default 0.8 for sharper response

    await this.setDevice(deviceId);

    this.setupOscillators();
    this.setupNoiseLayer();
    this.setupAmbientLayer();
    this.processModulation();
  }

  async setDevice(deviceId?: string) {
    if (!this.ctx || !this.analyser) return;

    if (this.micSource) {
      this.micSource.mediaStream.getTracks().forEach(t => t.stop());
      this.micSource.disconnect();
      this.micSource = null;
    }

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.analyser);
    } catch (err) {
      console.error("Microphone access denied", err);
    }
  }

  private setupAmbientLayer() {
    if (!this.ctx || !this.masterGain) return;

    // Create 2 seconds of noise
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    
    // Generate Brown noise approximation for a deep rumble
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      output[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = output[i];
      output[i] *= 3.5; // Compensate for gain reduction
    }

    this.ambientSource = this.ctx.createBufferSource();
    this.ambientSource.buffer = noiseBuffer;
    this.ambientSource.loop = true;

    // Lowpass filter to make it sound like a distant highway ("ゴー...")
    this.ambientFilter = this.ctx.createBiquadFilter();
    this.ambientFilter.type = 'lowpass';
    this.ambientFilter.frequency.value = 80; // Deep rumble
    this.ambientFilter.Q.value = 0.5;

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0.15 * this.config.droneLevel; // Thin, continuous layer

    this.ambientSource.connect(this.ambientFilter);
    this.ambientFilter.connect(this.ambientGain);
    
    // Connect to ducking filter to make room for voice
    if (this.duckingFilter) {
      this.ambientGain.connect(this.duckingFilter);
    } else if (this.reverb) {
      this.ambientGain.connect(this.reverb);
    } else {
      this.ambientGain.connect(this.masterGain);
    }
    
    this.ambientSource.start();
  }

  private setupNoiseLayer() {
    if (!this.ctx || !this.masterGain) return;

    // Create 2 seconds of white noise
    const bufferSize = this.ctx.sampleRate * 2;
    const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    this.noiseSource = this.ctx.createBufferSource();
    this.noiseSource.buffer = noiseBuffer;
    this.noiseSource.loop = true;

    // Bandpass filter for a "beautiful" pitched/crystalline noise
    this.noiseFilter = this.ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 4000;
    this.noiseFilter.Q.value = 1;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0;

    this.noiseSource.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    
    // Connect noise to ducking filter to make room for voice
    if (this.duckingFilter) {
      this.noiseGain.connect(this.duckingFilter);
    } else if (this.reverb) {
      this.noiseGain.connect(this.reverb);
    } else {
      this.noiseGain.connect(this.masterGain);
    }
    
    this.noiseSource.start();
  }

  private createReverbBuffer() {
    if (!this.ctx) return null;
    const length = this.ctx.sampleRate * 4; // 4 seconds
    const buffer = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
      }
    }
    return buffer;
  }

  private setupOscillators() {
    if (!this.ctx || !this.masterFilter) return;

    // Create 10 oscillators for a rich harmonic texture
    for (let i = 0; i < 10; i++) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      
      osc.type = i % 2 === 0 ? 'sine' : 'triangle';
      gain.gain.value = 0; // Start silent

      // Modulation path: Mic -> Filter -> Osc Gain?
      // For now, let's just make them respond to the environment later.
      
      osc.connect(gain);
      gain.connect(this.masterFilter);
      osc.start();
      
      this.oscillators.push({ osc, gain, baseFreq: 220 });
    }
  }

  updateConfig(newConfig: Partial<AudioEngineConfig>) {
    this.config = { ...this.config, ...newConfig };
    
    if (this.dryGain && this.wetGain) {
      this.dryGain.gain.setTargetAtTime(1 - this.config.reverbMix, this.ctx?.currentTime || 0, 0.1);
      this.wetGain.gain.setTargetAtTime(this.config.reverbMix, this.ctx?.currentTime || 0, 0.1);
    }
    
    if (this.ambientGain) {
      this.ambientGain.gain.setTargetAtTime(0.15 * this.config.droneLevel, this.ctx?.currentTime || 0, 0.1);
    }
  }

  private triggerChordUpdate(dominantFreq: number, low: number, mid: number, high: number) {
    if (!this.ctx) return;
    
    // 1. Determine Input Step in EDO based on input frequency
    const safeFreq = Math.max(dominantFreq, 40); // Clamp bottom to ~E1 (41Hz)
    let inputStep = Math.round(this.config.edo * Math.log2(safeFreq / this.baseFreq));
    this.currentInputStep = inputStep;

    // 2. Pick a modern tension chord pattern based on frequency balance
    const stackPatterns = [
      [7, 4, 3, 4, 3, 3, 4, 3, 4], // 0: Maj9(#11, 13) - Bright, airy tension
      [7, 3, 4, 3, 4, 3, 3, 4, 3],  // 1: m11(9) - Deep, melancholic Dorian tension
      [7, 3, 5, 5, 4, 4, 6, 5, 5], // 2: Dom7(#9, b13) - Dark, altered dominant tension
      [6, 4, 4, 3, 3, 4, 3, 3, 4], // 3: m7(b5, 11) - Mysterious, half-diminished tension
      [5, 5, 5, 4, 5, 5, 5, 5, 4], // 4: Quartal "So What" - Modern, open tension
      [4, 4, 3, 3, 4, 3, 3, 4, 4], // 5: Maj7(#5, 9) - Dreamy, augmented tension
    ];

    let patternIndex = 0;
    if (high > mid && high > low) patternIndex = 0; // Maj9(#11)
    else if (high > low) patternIndex = 4; // Quartal
    else if (low > mid && low > high) patternIndex = 2; // Altered Dom
    else if (low > high) patternIndex = 1; // m11
    else if (mid > high && mid > low) patternIndex = 5; // Augmented
    else patternIndex = 3; // Half-diminished

    const pattern = stackPatterns[patternIndex];
    
    // Calculate cumulative steps from root
    const cumulativeSteps = [0];
    let current = 0;
    for (let i = 0; i < 9; i++) {
      current += pattern[i];
      cumulativeSteps.push(current);
    }

    // 3. Decide which voice (0-9) the input pitch should be.
    // If the input is high, it becomes a higher voice in the chord, harmonizing *under* it.
    let targetVoiceIndex = Math.floor((inputStep + 15) / 12);
    targetVoiceIndex = Math.max(0, Math.min(9, targetVoiceIndex));

    // 4. Calculate the root step so that the target voice matches the input step exactly
    let rootStep = inputStep - cumulativeSteps[targetVoiceIndex];

    // Prevent the root from going too low (e.g., below E1 = ~41Hz, which is step -29 in 12-TET)
    while (rootStep < -29 && targetVoiceIndex > 0) {
      targetVoiceIndex--;
      rootStep = inputStep - cumulativeSteps[targetVoiceIndex];
    }

    this.currentRootStep = rootStep;

    // 5. Build the 10-note stack
    const newSteps = cumulativeSteps.map(step => this.currentRootStep + step);

    const now = this.ctx.currentTime;
    this.oscillators.forEach((o, i) => {
      const step = newSteps[i];
      const freq = this.baseFreq * Math.pow(2, step / this.config.edo);
      
      o.baseFreq = freq;
      o.osc.frequency.setTargetAtTime(freq, now, 0.05);
    });
  }

  private processModulation() {
    if (!this.ctx || !this.analyser) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    
    const update = () => {
      if (!this.ctx || !this.analyser) return;

      this.analyser.getByteFrequencyData(dataArray);
      
      // Calculate average volume/energy in specific bands
      let lowEnergy = 0;
      let midEnergy = 0;
      let highEnergy = 0;
      
      for (let i = 0; i < 10; i++) lowEnergy += dataArray[i];
      for (let i = 10; i < 100; i++) midEnergy += dataArray[i];
      for (let i = 100; i < 500; i++) highEnergy += dataArray[i];
      
      lowEnergy /= 10;
      midEnergy /= 90;
      // Boost high frequency reading because high frequency bins naturally have lower energy
      highEnergy = (highEnergy / 400) * 1.8;

      // Reduce input sensitivity by 15% for virtual piano/line-in sources
      const sensitivity = 0.85;
      lowEnergy *= sensitivity;
      midEnergy *= sensitivity;
      highEnergy *= sensitivity;

      const totalEnergy = (lowEnergy + midEnergy + highEnergy) / 3;
      const now = this.ctx!.currentTime;
      
      // --- REACTIVE CHORD GENERATION ---
      // Find dominant frequency bin (start from 2 to ignore DC offset/rumble)
      let maxVal = 0;
      let maxIndex = 0;
      for (let i = 2; i < this.analyser!.frequencyBinCount; i++) {
        if (dataArray[i] > maxVal) {
          maxVal = dataArray[i];
          maxIndex = i;
        }
      }

      // Parabolic interpolation for more accurate pitch detection
      let exactIndex = maxIndex;
      if (maxIndex > 2 && maxIndex < this.analyser!.frequencyBinCount - 1) {
        const valL = dataArray[maxIndex - 1];
        const valC = dataArray[maxIndex];
        const valR = dataArray[maxIndex + 1];
        const denominator = valL - 2 * valC + valR;
        if (denominator !== 0) {
          const shift = 0.5 * (valL - valR) / denominator;
          exactIndex = maxIndex + shift;
        }
      }

      const nyquist = this.ctx!.sampleRate / 2;
      const dominantFreq = (exactIndex / this.analyser!.frequencyBinCount) * nyquist;

      const delta = totalEnergy - this.lastEnergy;

      // --- DYNAMIC ENVELOPE TRACKING ---
      if (delta > 1) {
        // Delta typically ranges from 1 (slow swell) to 40+ (sharp clap)
        const sharpness = Math.min(1, Math.max(0, (delta - 1) / 30));
        
        // Fast attack -> small time constant (0.02). Slow attack -> large time constant (0.8)
        // Increased attack time by 10%
        const targetTC = (0.8 - sharpness * 0.78) * 1.1;
        this.dynamicTimeConstant = this.dynamicTimeConstant * 0.5 + targetTC * 0.5;
        
        // Fast attack -> sharp decay (15). Slow attack -> smooth decay (2)
        // Increased decay by 20% for faster release
        const targetDecay = (2 + sharpness * 13) * 1.25;
        this.dynamicPulseDecay = this.dynamicPulseDecay * 0.5 + targetDecay * 0.5;
      } else if (delta < -1) {
        // On release, slightly lengthen the time constant for a natural fade
        // Reduced max time constant from 1.0 to 0.8 for 20% faster release
        this.dynamicTimeConstant = Math.min(0.8, this.dynamicTimeConstant * 1.05);
      }

      // --- DYNAMIC DUCKING FILTER ---
      if (this.duckingFilter) {
        if (totalEnergy > 5 / this.config.sensitivity) {
          // Duck the dominant frequency of the input by up to duckingDepth dB
          const duckAmount = Math.max(-this.config.duckingDepth, -totalEnergy / 4);
          this.duckingFilter.frequency.setTargetAtTime(Math.max(100, dominantFreq), now, 0.05);
          this.duckingFilter.gain.setTargetAtTime(duckAmount, now, 0.05);
        } else {
          // Restore when silent
          this.duckingFilter.gain.setTargetAtTime(0, now, 0.2);
        }
      }

      // Trigger a new chord if there's an attack OR sustained sound, loosely following pitch
      const isAttack = (delta > 3 / this.config.sensitivity) && totalEnergy > 5 / this.config.sensitivity;
      const isSpeaking = totalEnergy > 8 / this.config.sensitivity; // Threshold for active input
      
      // Vocoder-like behavior: Lock the pitch while audio is being input.
      // Only trigger a new chord when transitioning from silence to speaking, 
      // or if there's a massive new attack after a brief pause.
      let shouldTrigger = false;
      if (isSpeaking && !this.wasSpeaking) {
        shouldTrigger = true; // Just started speaking
      } else if (isAttack && (now - this.lastChordTime > 1.5)) {
        shouldTrigger = true; // Huge new attack after a while
      }
      
      if (shouldTrigger && (now - this.lastChordTime > 0.2)) {
        if (maxVal * sensitivity > 15) { // Ensure there's a clear tonal peak
          this.triggerChordUpdate(dominantFreq, lowEnergy, midEnergy, highEnergy);
          this.lastChordTime = now;
        }
      }
      
      // Update speaking state with a little hysteresis to prevent rapid toggling
      if (totalEnergy > 10) {
        this.wasSpeaking = true;
      } else if (totalEnergy < 4) {
        this.wasSpeaking = false;
      }
      
      this.lastEnergy = totalEnergy;

      // --- DYNAMIC NOTE STACKING ---
      // Increased sensitivity: max out notes at lower volumes for indoor testing
      const volumeNotes = Math.min(7, Math.floor((totalEnergy / 60) * 10));
      const spreadNotes = (lowEnergy > 5 ? 1 : 0) + (midEnergy > 5 ? 1 : 0) + (highEnergy > 5 ? 1 : 0);
      const activeNotesCount = Math.min(10, volumeNotes + spreadNotes);

      // 1. Modulate Master Filter (Timbre change)
      // When silent, it's muffled (300Hz). When loud, it opens up dramatically
      if (this.masterFilter) {
        const targetFreq = 300 + Math.pow(totalEnergy / 100, 1.5) * 5700;
        this.masterFilter.frequency.setTargetAtTime(Math.min(targetFreq, 20000), now, 0.05);
      }

      // 2. Modulate oscillator gains and add slight pitch drift based on active notes
      this.oscillators.forEach((o, i) => {
        let targetGain = 0;
        
        // --- SLIGHT PITCH DRIFT (Vibrato / Organic fluctuation) ---
        // Even when pitch is locked, add a tiny bit of movement so it sounds alive
        if (o.baseFreq > 0) {
          // Drift amount scales slightly with frequency (higher notes drift a bit more in Hz, same in cents)
          // Use a combination of slow sine waves for organic movement
          const driftHz = (Math.sin(now * (1.5 + i * 0.2)) + Math.cos(now * (0.8 + i * 0.3))) * (o.baseFreq * 0.002);
          o.osc.frequency.setTargetAtTime(o.baseFreq + driftHz, now, 0.1);
        }

        if (i < activeNotesCount) {
          targetGain = 0.01; 
          
          // Increased sensitivity for individual oscillator gains
          if (i < 3) targetGain += Math.min(1, lowEnergy / 80) * 0.6;
          else if (i < 7) targetGain += Math.min(1, midEnergy / 80) * 0.45;
          else targetGain += Math.min(1, highEnergy / 80) * 0.3;

          // Add some "breathing" randomness
          targetGain *= (0.8 + Math.random() * 0.4);

          // --- REICH-STYLE PULSING (Interlocking Polyrhythms) ---
          // Oscillators 0, 1, 2 remain continuous (like bass clarinets/voices swelling)
          // Oscillators 3+ become rhythmic (like pianos/marimbas)
          if (i >= 3) {
            let pulseRate = 4; // 4 Hz (8th notes)
            if (i === 5 || i === 6) pulseRate = 6; // 6 Hz (Triplets)
            if (i === 7 || i === 8) pulseRate = 8; // 8 Hz (16th notes)
            if (i === 9) pulseRate = 3; // 3 Hz (Cross-rhythm)

            const phase = (now * pulseRate) % 1;
            // Use dynamic decay based on input attack sharpness
            const pulseEnv = Math.exp(-phase * this.dynamicPulseDecay); 
            
            // Boost slightly to compensate for the envelope reducing overall volume
            targetGain *= pulseEnv * 1.5; 
          }
        }
        
        // Apply dynamic time constant
        // Pulsing notes need a proportionally faster TC to track their envelopes,
        // but they still scale with the overall attack speed.
        const tc = i >= 3 ? this.dynamicTimeConstant * 0.15 : this.dynamicTimeConstant;
        o.gain.gain.setTargetAtTime(targetGain, now, tc);
      });

      // --- DYNAMIC NOISE & GLITCH LAYER ---
      if (this.noiseGain && this.noiseFilter) {
        // Base noise level: very subtle, scales with overall energy
        let targetNoiseGain = Math.min(0.015 * this.config.noiseLevel, (totalEnergy / 100) * 0.015 * this.config.noiseLevel);

        // Glitch trigger: on sharp attacks or randomly during sustained input
        const isGlitch = delta > 5 / this.config.sensitivity || (isSpeaking && Math.random() < 0.08);
        
        if (isGlitch) {
          // Spike the volume slightly for the glitch
          targetNoiseGain = Math.min(0.05, targetNoiseGain * 4); 
          
          // Randomize filter frequency for a crystalline/pitched glitch sound
          const glitchFreq = 800 + Math.random() * 8000;
          this.noiseFilter.frequency.setTargetAtTime(glitchFreq, now, 0.005);
          
          // High resonance makes it sound "beautiful" and pitched rather than harsh static
          this.noiseFilter.Q.setTargetAtTime(10 + Math.random() * 30, now, 0.005);
        } else {
          // Settle back to a breathy, wide bandpass sound
          this.noiseFilter.frequency.setTargetAtTime(4000, now, 0.5);
          this.noiseFilter.Q.setTargetAtTime(1, now, 0.5);
        }

        // Apply noise gain with dynamic time constant for tracking
        // 20% faster release tracking (0.5 -> 0.4)
        this.noiseGain.gain.setTargetAtTime(targetNoiseGain, now, this.dynamicTimeConstant * 0.4);
      }

      this.scheduleRhythm();

      requestAnimationFrame(update);
    };

    update();
  }

  getAnalyser() {
    return this.analyser;
  }

  private playPianoChord(time: number, steps: number[], velocity: number) {
    if (!this.ctx || !this.masterGain) return;
    
    // High-cut filter for the piano-like sound
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800 + (velocity * 1200); // 800Hz - 2000Hz depending on velocity
    filter.Q.value = 1.0; // Slight resonance for pluckiness
    filter.connect(this.masterGain);

    steps.forEach(step => {
      const freq = this.baseFreq * Math.pow(2, step / this.config.edo);
      
      // Carrier (Main sine wave)
      const carrier = this.ctx!.createOscillator();
      carrier.type = 'sine';
      carrier.frequency.value = freq;
      
      // Modulator (FM synthesis for electric piano-like timbre)
      const modulator = this.ctx!.createOscillator();
      modulator.type = 'sine';
      modulator.frequency.value = freq * 2; // Octave up for harmonic modulation
      
      const modGain = this.ctx!.createGain();
      // Modulation index: higher value = more harmonics. Decays quickly for a percussive attack.
      modGain.gain.setValueAtTime(freq * this.config.fmIndex * velocity, time);
      modGain.gain.exponentialRampToValueAtTime(freq * 0.1, time + 0.2);
      
      modulator.connect(modGain);
      modGain.connect(carrier.frequency); // Modulate carrier frequency
      
      // Sub warmth (Sine wave an octave down)
      const subOsc = this.ctx!.createOscillator();
      subOsc.type = 'sine';
      subOsc.frequency.value = freq / 2;
      
      // Noise burst for hammer strike
      const bufferSize = this.ctx!.sampleRate * 0.1; // 100ms
      const buffer = this.ctx!.createBuffer(1, bufferSize, this.ctx!.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      const noiseSource = this.ctx!.createBufferSource();
      noiseSource.buffer = buffer;
      
      const noiseFilter = this.ctx!.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = Math.min(freq * 4, 10000);
      noiseFilter.Q.value = 1.5;
      
      const noiseGain = this.ctx!.createGain();
      noiseGain.gain.setValueAtTime(0.05 * velocity, time);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.05); // Very short burst
      
      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(filter);
      
      const gain = this.ctx!.createGain();
      
      // Percussive envelope: 0 attack, exponential decay
      // Significantly increased volume (from 0.03 to 0.15)
      const peakGain = 0.15 * velocity;
      gain.gain.setValueAtTime(peakGain, time);
      // 20% shorter release (0.6 -> 0.48)
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.48);
      
      carrier.connect(gain);
      subOsc.connect(gain);
      gain.connect(filter);
      
      carrier.start(time);
      modulator.start(time);
      subOsc.start(time);
      noiseSource.start(time);
      
      // 20% shorter overall duration (1.0 -> 0.8)
      carrier.stop(time + 0.8);
      modulator.stop(time + 0.8);
      subOsc.stop(time + 0.8);
      
      // Cleanup filter after notes finish to prevent memory leaks
      setTimeout(() => {
        try { filter.disconnect(); } catch (e) {}
      }, 1500);
    });
  }

  private scheduleRhythm() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    
    // Initialize rhythm time if it's 0 or too far in the past
    if (this.nextRhythmTime === 0 || this.nextRhythmTime < now - 1) {
      this.nextRhythmTime = now + 0.1;
    }

    const lookahead = 0.1; // 100ms lookahead
    const stepDuration = 60 / this.config.bpm / 4; // 16th note duration based on BPM
    
    // Determine rhythm pattern
    let currentPattern: number[] = [];
    switch (this.config.rhythmPattern) {
      case 'tresillo':
        currentPattern = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0];
        break;
      case 'fourOnTheFloor':
        currentPattern = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        break;
      case 'none':
        currentPattern = [0];
        break;
      case 'random':
      default:
        // Randomly generate a pattern step
        currentPattern = [Math.random() > 0.7 ? 1 : 0];
        break;
    }
    
    while (this.nextRhythmTime < now + lookahead) {
      // Randomly trigger stutter on the drone (15% chance every measure, only if there's energy)
      if (this.rhythmStep % 16 === 0 && Math.random() < 0.15 && this.lastEnergy > 4) {
        this.stutterStepsRemaining = 4 + Math.floor(Math.random() * 5); // Stutter for 4 to 8 steps
        this.stutterSpeed = Math.random() > 0.5 ? 2 : 1; // 50% chance of 32nd notes
      }

      if (this.droneGain) {
        if (this.stutterStepsRemaining > 0) {
          if (this.stutterSpeed === 1) {
            // 16th note stutter (on for 40%, off for 60%)
            this.droneGain.gain.setTargetAtTime(1.0, this.nextRhythmTime, 0.01);
            this.droneGain.gain.setTargetAtTime(0.0, this.nextRhythmTime + stepDuration * 0.4, 0.01);
          } else {
            // 32nd note stutter (two pulses per step)
            this.droneGain.gain.setTargetAtTime(1.0, this.nextRhythmTime, 0.005);
            this.droneGain.gain.setTargetAtTime(0.0, this.nextRhythmTime + stepDuration * 0.2, 0.005);
            this.droneGain.gain.setTargetAtTime(1.0, this.nextRhythmTime + stepDuration * 0.5, 0.005);
            this.droneGain.gain.setTargetAtTime(0.0, this.nextRhythmTime + stepDuration * 0.7, 0.005);
          }
          
          this.stutterStepsRemaining--;
          
          if (this.stutterStepsRemaining === 0) {
            // Restore full volume after stutter ends
            this.droneGain.gain.setTargetAtTime(1.0, this.nextRhythmTime + stepDuration, 0.05);
          }
        }
      }

      // Lowered threshold from 8 to 4 so it triggers more easily when speaking
      if (this.lastEnergy > 4 / this.config.sensitivity) {
        let isHit = false;
        if (this.config.rhythmPattern === 'random') {
          isHit = Math.random() > 0.7;
        } else if (this.config.rhythmPattern !== 'none') {
          isHit = currentPattern[this.rhythmStep % currentPattern.length] === 1;
        }
        
        if (isHit) {
          // Determine target inner voices based on a slowly changing chord quality
          // Cycle through chord qualities every 32 steps (2 measures)
          const chordType = Math.floor(this.rhythmStep / 32) % 4;
          let targetOffsets: number[]; // Offsets BELOW the input step
          
          if (chordType === 0) {
            targetOffsets = [-11, -7, -4]; // Major 7th structure down
          } else if (chordType === 1) {
            targetOffsets = [-10, -7, -4]; // Dominant 7th structure down
          } else if (chordType === 2) {
            targetOffsets = [-9, -7, -3]; // Minor 6th structure down
          } else {
            targetOffsets = [-11, -9, -6]; // Lydian structure down
          }

          // Move current inner voices slowly towards target voices (1-2 steps per hit)
          for (let i = 0; i < 3; i++) {
            const target = this.currentInputStep + targetOffsets[i];
            const diff = target - this.pianoInnerVoices[i];
            if (diff > 0) {
              this.pianoInnerVoices[i] += diff > 3 ? 2 : 1;
            } else if (diff < 0) {
              this.pianoInnerVoices[i] -= diff < -3 ? 2 : 1;
            }
          }

          // The chord always includes the inner voices and the input step
          const chordSteps = [...this.pianoInnerVoices, this.currentInputStep];

          // trackingProb chance input is top note. Otherwise we add a note above it.
          if (Math.random() > this.config.trackingProb) {
            // Add a major third (4 steps) or perfect fifth (7 steps) above the input step
            const extraNoteOffset = Math.random() > 0.5 ? 4 : 7;
            chordSteps.push(this.currentInputStep + extraNoteOffset);
          }

          // Velocity variation for groove
          const velocity = (this.rhythmStep % 4 === 0) ? 1.0 : 0.6;
          
          this.playPianoChord(this.nextRhythmTime, chordSteps, velocity);
        }
      }
      
      this.nextRhythmTime += stepDuration;
      this.rhythmStep++;
    }
  }

  stop() {
    if (this.micSource) {
      this.micSource.mediaStream.getTracks().forEach(t => t.stop());
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.noiseSource) {
      this.noiseSource.stop();
      this.noiseSource.disconnect();
      this.noiseSource = null;
    }
    if (this.noiseFilter) {
      this.noiseFilter.disconnect();
      this.noiseFilter = null;
    }
    if (this.noiseGain) {
      this.noiseGain.disconnect();
      this.noiseGain = null;
    }
    if (this.ambientSource) {
      this.ambientSource.stop();
      this.ambientSource.disconnect();
      this.ambientSource = null;
    }
    if (this.ambientFilter) {
      this.ambientFilter.disconnect();
      this.ambientFilter = null;
    }
    if (this.ambientGain) {
      this.ambientGain.disconnect();
      this.ambientGain = null;
    }

    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
  }
}

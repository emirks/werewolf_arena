import { useEffect, useRef } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import '../styles/AudioControls.css';

export const AudioControls = ({ isMuted, onToggleMute }) => {
  const { localParticipant } = useLocalParticipant();
  const audioLevelRef = useRef(null);
  const animationFrameRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);

  // Set up audio level visualization
  useEffect(() => {
    if (!localParticipant) return;

    const setupAudioMeter = async () => {
      try {
        // Get the audio track from the local participant
        const audioTrack = localParticipant.trackPublications.get(
          localParticipant.audioTrackPublications[0]?.track?.sid
        )?.track;
        
        if (!audioTrack) return;

        // Create audio context and analyser
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 32;
        
        const source = audioContext.createMediaStreamSource(
          new MediaStream([audioTrack.mediaStreamTrack])
        );
        
        source.connect(analyser);
        
        // Store references for cleanup
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        sourceRef.current = source;
        
        // Start animation loop
        const updateAudioLevel = () => {
          if (!audioLevelRef.current || !analyser) {
            animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
            return;
          }
          
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(dataArray);
          
          // Calculate average volume
          const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          const level = Math.min(average / 100, 1); // Normalize to 0-1
          
          // Update the level bar
          audioLevelRef.current.style.transform = `scaleX(${level})`;
          
          animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
        };
        
        updateAudioLevel();
      } catch (error) {
        console.error('Error setting up audio meter:', error);
      }
    };

    setupAudioMeter();

    return () => {
      // Clean up animation frame
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      
      // Clean up audio context
      if (sourceRef.current) {
        sourceRef.current.disconnect();
      }
      
      if (analyserRef.current) {
        analyserRef.current.disconnect();
      }
      
      if (audioContextRef.current?.state !== 'closed') {
        audioContextRef.current?.close();
      }
    };
  }, [localParticipant]);

  return (
    <div className="audio-controls">
      <button 
        className={`mute-button ${isMuted ? 'muted' : ''}`}
        onClick={onToggleMute}
        aria-label={isMuted ? 'Unmute' : 'Mute'}
      >
        {isMuted ? '🔇 Unmute' : '🎤 Mute'}
      </button>
      
      <div className="audio-level-container">
        <div className="audio-level" ref={audioLevelRef} />
      </div>
      
      <div className="audio-hint">
        {isMuted ? 'You are muted' : 'You are live'}
      </div>
    </div>
  );
};

import { useEffect, useRef, useState, useCallback } from 'react';
import { Participant as ParticipantType, Track, RemoteParticipant, LocalParticipant } from 'livekit-client';
import '../styles/Participant.css';

/**
 * @typedef {Object} ParticipantProps
 * @property {RemoteParticipant|LocalParticipant} participant - The LiveKit participant
 * @property {boolean} isLocal - Whether this is the local participant
 * @property {boolean} [isSpeaking] - Whether the participant is currently speaking
 * @property {string} [role] - The participant's role in the game
 * @property {boolean} [isAlive] - Whether the participant is alive
 */

/**
 * Participant component that renders a single participant's UI and handles their audio
 * @param {ParticipantProps} props - Component props
 */
export const Participant = ({ 
  participant, 
  audioTracks,
  isLocal, 
  isSpeaking: externalIsSpeaking = false,
  role = 'villager',
  isAlive = true
}) => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const audioRef = useRef(null);
  
  // Create audio elements for each track
  useEffect(() => {
    if (!audioRef.current || !audioTracks || audioTracks.length === 0) {
      // Clean up if no tracks
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.srcObject = null;
      }
      return;
    }
    
    try {
      const mediaStream = new MediaStream();
      let hasAudioTracks = false;
      
      // Add all audio tracks to the media stream
      audioTracks.forEach((track) => {
        if (track.mediaStreamTrack) {
          mediaStream.addTrack(track.mediaStreamTrack);
          hasAudioTracks = true;
        } else if (track.track) {
          // Handle case where track is wrapped in a track property
          mediaStream.addTrack(track.track.mediaStreamTrack);
          hasAudioTracks = true;
        }
      });
      
      if (!hasAudioTracks) return;
      
      // Set the new stream and play
      const audioElement = audioRef.current;
      audioElement.srcObject = mediaStream;
      audioElement.volume = isMuted ? 0 : 1;
      
      // Handle autoplay restrictions
      const handleFirstInteraction = () => {
        audioElement.play().catch(console.error);
        document.removeEventListener('click', handleFirstInteraction);
        document.removeEventListener('touchstart', handleFirstInteraction);
      };
      const playPromise = audioElement.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.warn('Error playing audio:', error);
          // Handle autoplay restrictions
          if (error.name === 'NotAllowedError' || error.name === 'NotAllowedError') {
            console.log('Please interact with the page to enable audio playback');
            // Add a click handler to start playback on user interaction
            document.addEventListener('click', handleFirstInteraction);
            document.addEventListener('touchstart', handleFirstInteraction);
          }
        });
      }
      
      return () => {
        // Clean up event listeners
        document.removeEventListener('click', handleFirstInteraction);
        document.removeEventListener('touchstart', handleFirstInteraction);
        
        // Clean up audio element
        if (audioElement) {
          audioElement.pause();
          audioElement.srcObject = null;
        }
        
        // Stop all tracks when cleaning up
        mediaStream.getTracks().forEach(track => {
          track.stop();
        });
      };
    } catch (error) {
      console.error('Error setting up audio:', error);
    }
  }, [audioTracks, isMuted]);

  // Determine role-based styling
  const getRoleClass = () => {
    if (!role) return '';
    return `role-${role.toLowerCase().replace(/\s+/g, '-')}`;
  };
  
  // Determine if the participant is currently speaking (either from props or local state)
  const speaking = typeof externalIsSpeaking !== 'undefined' ? externalIsSpeaking : isSpeaking;
  
  return (
    <div 
      className={`participant 
        ${isLocal ? 'local' : 'remote'} 
        ${speaking ? 'speaking' : ''} 
        ${getRoleClass()}
        ${!isAlive ? 'eliminated' : ''}`}
      data-identity={participant.identity}
      data-role={role}
    >
      <div className="participant-info">
        <div className="participant-avatar">
          {/* You can add avatar or role icon here */}
          <span className="avatar-icon">
            {role ? role.charAt(0).toUpperCase() : 'P'}
          </span>
          {!isAlive && <div className="eliminated-overlay">💀</div>}
        </div>
        <div className="participant-details">
          <span className="participant-name">
            {participant.identity} {isLocal && <span className="you-badge">(You)</span>}
          </span>
          {role && <span className="participant-role">{role}</span>}
        </div>
      </div>
      
      <div className="participant-status">
        {speaking && (
          <span className="speaking-indicator" title="Speaking">
            <span className="pulse-animation"></span>
            <span className="mic-icon">🎤</span>
          </span>
        )}
        {isMuted && <span className="muted-indicator" title="Muted">🔇</span>}
      </div>
      
      <audio 
        ref={audioRef} 
        autoPlay 
        playsInline 
        className="participant-audio"
        data-participant-id={participant.identity}
      />
    </div>
  );
};

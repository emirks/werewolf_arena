import { useState, useEffect, useCallback } from 'react';
import { Room, Track } from 'livekit-client';
import { joinRoom, startGameSession } from '../utils/api';

export const useLiveKit = (initialRoomName, playerName, onConnected, onDisconnected) => {
  const [room, setRoom] = useState(null);
  const [roomName, setRoomName] = useState(initialRoomName);
  const [participants, setParticipants] = useState([]);
  const [audioTracks, setAudioTracks] = useState(new Map());
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [isMuted, setIsMuted] = useState(false);

  // Connect to LiveKit room
  const connect = useCallback(async () => {
    if (!playerName || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      // Join the room and get LiveKit connection details
      const { url, token, room_name } = await joinRoom(playerName);
      
      // Update the room name from the server response
      setRoomName(room_name);
      
      // Create a new room
      const newRoom = new Room({
        // Automatically manage audio/video tracks
        autoSubscribe: true,
        // Adaptive bitrate for better quality
        adaptiveStream: true,
        // Enable dynacast for better quality on varying network conditions
        dynacast: true,
        // Optimize for audio conferencing
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Set up event listeners before connecting
      newRoom
        .on('participantConnected', handleParticipantConnected)
        .on('participantDisconnected', handleParticipantDisconnected)
        .on('trackSubscribed', handleTrackSubscribed)
        .on('trackUnsubscribed', handleTrackUnsubscribed)
        .on('disconnected', handleDisconnected)
        .on('reconnecting', () => console.log('Reconnecting to room...'))
        .on('reconnected', () => console.log('Reconnected to room'))
        .on('localTrackPublished', handleLocalTrackPublished)
        .on('localTrackUnpublished', handleLocalTrackUnpublished);

      // Connect to the LiveKit server
      await newRoom.connect(url, token, {
        autoSubscribe: true,
      });

      // Publish local audio track
      await newRoom.localParticipant.setMicrophoneEnabled(true);
      
      setRoom(newRoom);
      setParticipants(Array.from(newRoom.remoteParticipants.values()));
      
      if (onConnected) {
        onConnected(newRoom);
      }
      
      return newRoom;
    } catch (err) {
      console.error('Error connecting to LiveKit:', err);
      setError(err.message || 'Failed to connect to the room');
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, [roomName, playerName, isConnecting, onConnected]);

  // Disconnect from the room
  const disconnect = useCallback(async () => {
    if (!room) return;
    
    try {
      await room.disconnect();
      if (onDisconnected) {
        onDisconnected();
      }
    } catch (err) {
      console.error('Error disconnecting from room:', err);
    } finally {
      setRoom(null);
      setRoomName('');
      setParticipants([]);
      setAudioTracks(new Map());
    }
  }, [room, onDisconnected]);
  
  // Start the game
  const startGame = useCallback(async (playerRole) => {
    if (!roomName || !playerName) return;
    
    try {
      const gameState = await startGameSession(roomName, playerName, playerRole);
      return gameState;
    } catch (error) {
      console.error('Error starting game:', error);
      throw error;
    }
  }, [roomName, playerName]);

  // Toggle mute state
  const toggleMute = useCallback(async () => {
    if (!room) return;
    
    try {
      if (isMuted) {
        await room.localParticipant.setMicrophoneEnabled(true);
      } else {
        await room.localParticipant.setMicrophoneEnabled(false);
      }
      setIsMuted(!isMuted);
    } catch (err) {
      console.error('Error toggling mute:', err);
    }
  }, [room, isMuted]);

  // Event handlers
  const handleParticipantConnected = useCallback((participant) => {
    setParticipants((prev) => [...prev, participant]);
  }, []);

  const handleParticipantDisconnected = useCallback((participant) => {
    setParticipants((prev) => prev.filter((p) => p.sid !== participant.sid));
    
    // Clean up audio tracks for this participant
    setAudioTracks((prev) => {
      const newTracks = new Map(prev);
      newTracks.delete(participant.sid);
      return newTracks;
    });
  }, []);  

  const handleTrackSubscribed = useCallback((track, publication, participant) => {
    if (track.kind === Track.Kind.Audio) {
      setAudioTracks((prev) => {
        const newTracks = new Map(prev);
        const participantTracks = newTracks.get(participant.sid) || [];
        
        if (!participantTracks.includes(track)) {
          newTracks.set(participant.sid, [...participantTracks, track]);
        }
        
        return newTracks;
      });
    }
  }, []);

  const handleTrackUnsubscribed = useCallback((track, publication, participant) => {
    if (track.kind === Track.Kind.Audio) {
      setAudioTracks((prev) => {
        const newTracks = new Map(prev);
        const participantTracks = newTracks.get(participant.sid) || [];
        
        newTracks.set(
          participant.sid,
          participantTracks.filter((t) => t.sid !== track.sid)
        );
        
        return newTracks;
      });
    }
  }, []);

  const handleLocalTrackPublished = useCallback((publication) => {
    console.log('Local track published:', publication.kind);
  }, []);

  const handleLocalTrackUnpublished = useCallback((publication) => {
    console.log('Local track unpublished:', publication.kind);
  }, []);

  const handleDisconnected = useCallback(() => {
    console.log('Disconnected from room');
    setRoom(null);
    setParticipants([]);
    setAudioTracks(new Map());
    
    if (onDisconnected) {
      onDisconnected();
    }
  }, [onDisconnected]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (room) {
        room.disconnect().catch(console.error);
      }
    };
  }, [room]);

  return {
    room,
    roomName,
    participants,
    audioTracks,
    isConnecting,
    error,
    isMuted,
    connect,
    disconnect,
    startGame: startGameSession,
    toggleMute,
  };
};

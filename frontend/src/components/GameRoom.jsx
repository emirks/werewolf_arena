import { useEffect, useState, useCallback, useRef } from 'react';
import { Track, Room } from 'livekit-client';
import { Participant } from './Participant';
import { AudioControls } from './AudioControls';
import { GameUI } from './GameUI';
import '../styles/GameRoom.css';

/**
 * @typedef {Object} GameRoomProps
 * @property {string} roomName - The name of the current room
 * @property {string} playerName - The name of the current player
 * @property {string} playerRole - The role of the current player
 * @property {Room} room - The LiveKit room instance
 */

/**
 * GameRoom component that handles the main game interface with participants and game UI
 * @param {GameRoomProps} props - Component props
 */
export const GameRoom = ({ roomName, playerName, playerRole, room }) => {
  const [canSpeak, setCanSpeak] = useState(false);
  const [isVoting, setIsVoting] = useState(false);
  const [votedPlayer, setVotedPlayer] = useState(null);
  const [currentTurn, setCurrentTurn] = useState(1);
  const maxTurns = 5; // Example max turns per phase
  const [participants, setParticipants] = useState([]);
  // Track audio tracks per participant
  const [participantTracks, setParticipantTracks] = useState(new Map());
  const [isMuted, setIsMuted] = useState(false);
  const [gameState, setGameState] = useState({
    phase: 'lobby',
    players: [],
    currentPlayer: {
      id: room?.localParticipant?.identity,
      name: playerName,
      role: playerRole,
      isHost: false
    },
  });
  
  // Track mounted state to prevent state updates after unmount
  const isMounted = useRef(true);
  
  // // Cleanup on unmount
  // useEffect(() => {
  //   return () => {
  //     isMounted.current = false;
  //   };
  // }, []);

  // Handle remote participants and data messages
  useEffect(() => {
    if (!room) return;

    const onParticipantConnected = (participant) => {
      console.log('Participant connected:', participant.identity);
      if (!isMounted.current) return;
      
      setParticipants(prev => {
        // Don't add if already in the list
        if (prev.some(p => p.identity === participant.identity)) return prev;
        return [...prev, participant];
      });
      
      // Add to game state
      setGameState(prev => ({
        ...prev,
        players: [
          ...prev.players,
          {
            id: participant.identity,
            name: participant.identity,
            isAlive: true,
            role: 'villager' // Default role, will be updated by game state
          }
        ]
      }));
    };

    const onParticipantDisconnected = (participant) => {
      console.log('Participant disconnected:', participant.identity);
      if (!isMounted.current) return;
      
      setParticipants(prev => prev.filter((p) => p.identity !== participant.identity));
      
      // Update game state
      setGameState(prev => ({
        ...prev,
        players: prev.players.filter(p => p.id !== participant.identity)
      }));
    };

    const onTrackSubscribed = (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio) {
        console.log('Audio track subscribed:', track.sid, 'for', participant.identity);
        setParticipantTracks(prev => {
          const newTracks = new Map(prev);
          const participantTracks = newTracks.get(participant.identity) || [];
          
          // Don't add duplicate tracks
          if (!participantTracks.some(t => t.sid === track.sid)) {
            newTracks.set(participant.identity, [...participantTracks, track]);
          }
          
          return newTracks;
        });
      }
    };

    const onTrackUnsubscribed = (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio) {
        console.log('Audio track unsubscribed:', track.sid, 'for', participant.identity);
        setParticipantTracks(prev => {
          const newTracks = new Map(prev);
          const participantTracks = newTracks.get(participant.identity) || [];
          
          if (participantTracks.length > 0) {
            newTracks.set(
              participant.identity,
              participantTracks.filter(t => t.sid !== track.sid)
            );
          }
          
          return newTracks;
        });
      }
    };

    const onDataReceived = (data, participant, kind, topic) => {
      try {
        const message = JSON.parse(new TextDecoder().decode(data));
        console.log('Received game message:', message, 'from', participant.identity);
        handleGameMessage(message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    };

    // Set initial participants
    const initialParticipants = Array.from(room.remoteParticipants.values());
    setParticipants(initialParticipants);
    
    // Initialize game state with existing participants
    setGameState(prev => ({
      ...prev,
      players: initialParticipants.map(p => ({
        id: p.identity,
        name: p.identity,
        isAlive: true,
        role: 'villager'
      }))
    }));
    
    // Set up event listeners
    room
      .on('participantConnected', onParticipantConnected)
      .on('participantDisconnected', onParticipantDisconnected)
      .on('trackSubscribed', onTrackSubscribed)
      .on('trackUnsubscribed', onTrackUnsubscribed)
      .on('dataReceived', onDataReceived);

    return () => {
      room
        .off('participantConnected', onParticipantConnected)
        .off('participantDisconnected', onParticipantDisconnected)
        .off('trackSubscribed', onTrackSubscribed)
        .off('trackUnsubscribed', onTrackUnsubscribed)
        .off('dataReceived', onDataReceived);
    };
  }, [room]);

  const handleGameMessage = useCallback((message) => {
    if (!isMounted.current) return;
    
    console.log('Handling game message:', message);
    
    switch (message.type) {
      case 'game_state':
        switch (message.update_type) {
          case 'game_state_update':
            setGameState(prev => {
              // Update current turn from game state if available
              if (message.data.currentTurn) {
                setCurrentTurn(message.data.currentTurn);
              }
              return {
                ...prev,
                ...message.data,
                players: message.data.players || prev.players
              };
            });
            break;
          case 'day_phase_start':
            setGameState(prev => ({
              ...prev,
              players: message.data.players || prev.players,
              phase: 'day',
              currentTurn: message.data.round || 1,
              maxTurns: message.data.maxTurns || 5
            }));
            setCurrentTurn(message.data.round || 1);
            break;
            
          case 'debate_update':
            setGameState(prev => ({
              ...prev,
              currentTurn: message.data.round,
              currentSpeaker: message.data.speaker,
              maxTurns: message.data.maxTurns
            }));
            setCurrentTurn(message.data.round);
            
            // If it's the local player's turn, show speaking prompt
            if (message.data.speaker === playerName) {
              setCanSpeak(true);
              // Auto-hide after speaking time is done
              const speakTime = message.data.speakTime || 30; // Default 30 seconds
              setTimeout(() => setCanSpeak(false), speakTime * 1000);
            }
            break;
            
          case 'player_update':
            setGameState(prev => ({
              ...prev,
              players: prev.players.map(p => 
                p.id === message.data.id ? { ...p, ...message.data } : p
              )
            }));
            break;

          case 'voting_started':
            setIsVoting(true);
            setVotedPlayer(null);
            // Update game state to voting phase
            setGameState(prev => ({
              ...prev,
              phase: 'voting',
              voting: {
                ...prev.voting,
                isActive: true,
                votes: {}
              }
            }));
            break;
            
          case 'voting_ended':
            setIsVoting(false);
            setGameState(prev => ({
              ...prev,
              voting: {
                ...prev.voting,
                isActive: false
              }
            }));
            break;
            
          case 'vote_received':
            const { voter, target } = message.data;
            if (voter === room.localParticipant.identity) {
              setVotedPlayer(target);
            }
            
            // Update voting state
            setGameState(prev => ({
              ...prev,
              voting: {
                ...prev.voting,
                votes: {
                  ...prev.voting?.votes,
                  [voter]: target
                }
              }
            }));
            break;
            
          case 'phase_change':
            setGameState(prev => ({
              ...prev,
              phase: message.data.phase,
              phaseData: message.data
            }));
            break;      
            
          default:
            break;
        }
        break;

      case 'can_speak':
        setCanSpeak(true);
        // Auto-hide after specified time or default to 5 seconds
        const speakTime = message.data?.timeout ? message.data.timeout * 1000 : 5000;
        setTimeout(() => setCanSpeak(false), speakTime);
        break;
                
      default:
        console.log('Unhandled message type:', message.type);
    }
  }, []);

  const handleVote = useCallback((playerId) => {
    if (!room) return;
    
    const message = {
      type: 'vote',
      target: playerId,
      voter: room.localParticipant.identity
    };
    
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(message)),
      { reliable: true }
    );
    
    // Update local state
    setVotedPlayer(playerId);
  }, [room]);

  const handleVoteSubmit = useCallback(() => {
    if (!room || !votedPlayer) return;
    
    const message = {
      type: 'submit_vote',
      target: votedPlayer,
      voter: room.localParticipant.identity
    };
    
    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(message)),
      { reliable: true }
    );
    
    // Disable voting UI after submission
    setIsVoting(false);
  }, [room, votedPlayer]);

  const toggleMute = useCallback(async () => {
    if (!room) return;
    
    try {
      if (isMuted) {
        await room.localParticipant.setMicrophoneEnabled(true);
      } else {
        await room.localParticipant.setMicrophoneEnabled(false);
      }
      setIsMuted(!isMuted);
    } catch (error) {
      console.error('Error toggling mute:', error);
    }
  }, [isMuted, room]);

  const sendMessage = useCallback((message) => {
    if (!room) return false;
    
    try {
      const payload = JSON.stringify(message);
      room.localParticipant.publishData(
        new TextEncoder().encode(payload),
        { reliable: true }
      );
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }, [room]);
  
  const handleAction = useCallback((action, target) => {
    sendMessage({
      type: 'action',
      action,
      target,
      timestamp: Date.now()
    });
  }, [sendMessage]);

  const sendChatMessage = useCallback((message) => {
    sendMessage({
      type: 'chat',
      message,
      timestamp: Date.now()
    });
  }, [sendMessage]);

  if (!room) {
    return (
      <div className="game-room loading">
        <div className="loading-message">Connecting to room...</div>
      </div>
    );
  }

  return (
    <div className="game-room">
      <div className="game-header">
        <h2>Room: {roomName}</h2>
        <div className="player-info">
          {playerName} ({playerRole}) 
          <span className={`connection-status ${room.state === 'connected' ? 'connected' : 'disconnected'}`}>
            {room.state === 'connected' ? '●' : '○'}
          </span>
        </div>
      </div>
      
      <div className="game-content">
        <div className="participants-grid">
          {participants.map((participant) => {
            const tracks = Array.from(participantTracks.get(participant.identity) || []);
            return (
              <Participant
                key={participant.identity}
                audioTracks={tracks}
                participant={participant}
                isLocal={participant.identity === playerName}
                isSpeaking={false} // This would come from audio level monitoring
                role={gameState.players.find(p => p.id === participant.identity)?.role || 'villager'}
              />
            );
          })}
        </div>
        
        <div className="game-ui-container">
          <GameUI
            gameState={gameState}
            onVote={handleVote}
            onAction={handleAction}
            onChatMessage={sendChatMessage}
            playerName={playerName}
            playerRole={playerRole}
            currentTurn={currentTurn}
            maxTurns={maxTurns}
            canSpeak={canSpeak}
            isVoting={isVoting}
            onVoteSubmit={handleVoteSubmit}
            votedPlayer={votedPlayer}
          />
        </div>
      </div>
      
      <AudioControls 
        isMuted={isMuted}
        onToggleMute={toggleMute}
        onDisconnect={() => room.disconnect()}
      />
      
      {gameState.announcements?.length > 0 && (
        <div className="announcements">
          {gameState.announcements.map(announcement => (
            <div key={announcement.id} className="announcement">
              {announcement.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

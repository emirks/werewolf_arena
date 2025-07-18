import { useEffect, useState, useCallback, useRef } from 'react';
import { RoomEvent, Track } from 'livekit-client';
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
  // State management
  const [participants, setParticipants] = useState([]);
  const [participantTracks, setParticipantTracks] = useState(new Map());
  const [isMuted, setIsMuted] = useState(false);
  const [gameState, setGameState] = useState({
    phase: 'lobby',
    round: 0,
    players: [],
    currentPlayer: {
      id: room?.localParticipant?.identity,
      name: playerName,
      role: playerRole,
      isHost: false
    },
    logs: [],
    announcements: [],
    debate: {
      current_speaker: null,
      current_turn: 0,
      max_turns: 8,
      history: [],
      turns_left: 8
    },
    voting: {
      active: false,
      votes: {},
      voted_player: null,
      results: null
    },
    targetSelection: {
      active: false,
      action: null,
      options: [],
      prompt: ''
    },
    interaction: {
      can_speak: false,
      speak_timeout: null,
      speaking_prompt: ''
    }
  });

  const isMounted = useRef(true);
  const speakTimeoutRef = useRef(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      if (speakTimeoutRef.current) {
        clearTimeout(speakTimeoutRef.current);
      }
    };
  }, []);

  const handleGameStateUpdate = useCallback((newGameState) => {
    if (!isMounted.current) return;

    console.log('Received game state:', newGameState);

    setGameState(prev => {
      // Update players based on the new game state
      const updatedPlayers = (newGameState.players || []).map(player => {
        const existingPlayer = prev.players.find(p => p.id === player.id) || {};
        return {
          ...existingPlayer,
          ...player,
          isAlive: player.isAlive !== undefined ? player.isAlive : true,
        };
      });

      // If current_players is provided, use that to determine alive status
      if (newGameState.current_players) {
        updatedPlayers.forEach(player => {
          player.isAlive = newGameState.current_players.includes(player.id || player.name);
        });
      }

      return {
        ...prev,
        phase: newGameState.phase || prev.phase,
        round: newGameState.round || prev.round,
        players: updatedPlayers,
        logs: newGameState.observations || prev.logs,
        currentPlayer: {
          ...prev.currentPlayer,
          role: newGameState.role || prev.currentPlayer.role,
        },
        debate: {
          ...prev.debate,
          turns_left: newGameState.debate_turns_left || prev.debate.turns_left,
          max_turns: newGameState.num_players || prev.debate.max_turns,
        }
      };
    });
  }, []);

  // Simplified message handler
  const handleMessage = useCallback((message) => {
    console.log('Received message:', message);

    switch (message.type) {
      case 'game_event':
        handleGameEvent(message);
        break;
      
      case 'user_action':
        handleUserAction(message);
        break;
      
      case 'announcement':
        handleAnnouncement(message);
        break;
      
      default:
        console.warn('Unknown message type:', message.type);
    }
  }, []);

  const handleGameEvent = useCallback((message) => {
    const { event, data, game_state } = message;

    // Update game state if provided
    if (game_state) {
      handleGameStateUpdate(game_state);
    }

    switch (event) {
      case 'phase_change':
        setGameState(prev => ({
          ...prev,
          phase: data.phase,
          round: data.round || prev.round,
          // Reset relevant state for new phase
          ...(data.phase === 'day' && {
            debate: { ...prev.debate, current_speaker: null, current_turn: 0, history: [] },
            voting: { ...prev.voting, active: false, voted_player: null, votes: {} },
            interaction: { ...prev.interaction, can_speak: false }
          }),
          ...(data.phase === 'night' && {
            interaction: { ...prev.interaction, can_speak: false }
          }),
          ...(data.phase === 'voting' && {
            voting: { ...prev.voting, active: true, voted_player: null, votes: {} },
            interaction: { ...prev.interaction, can_speak: false }
          })
        }));
        break;

      case 'debate_update':
        if (data.speaker && data.dialogue !== undefined) {
          setGameState(prev => ({
            ...prev,
            phase: 'day',
            debate: {
              ...prev.debate,
              current_speaker: data.speaker,
              current_turn: data.turn || prev.debate.current_turn + 1,
              history: [...prev.debate.history, { speaker: data.speaker, dialogue: data.dialogue, turn: data.turn }],
              turns_left: Math.max(0, prev.debate.max_turns - (data.turn || prev.debate.current_turn + 1))
            }
          }));
        }
        if (data.speaking_ended) {
          setGameState(prev => ({
            ...prev,
            interaction: { ...prev.interaction, can_speak: false, speaking_prompt: '' }
          }));
        }
        break;

      case 'voting_update':
        switch (data.event) {
          case 'voting_started':
            setGameState(prev => ({
              ...prev,
              voting: { ...prev.voting, active: true, votes: {}, voted_player: null }
            }));
            break;
          case 'vote_received':
            setGameState(prev => ({
              ...prev,
              voting: { ...prev.voting, votes: { ...prev.voting.votes, [data.voter]: data.target } }
            }));
            break;
          case 'voting_ended':
            setGameState(prev => ({
              ...prev,
              voting: { ...prev.voting, active: false, results: data.votes || prev.voting.votes }
            }));
            break;
          case 'voting_results':
            setGameState(prev => ({
              ...prev,
              voting: { ...prev.voting, results: data.results }
            }));
            break;
        }
        break;

      case 'player_update':
        if (data.exiled_player) {
          setGameState(prev => ({
            ...prev,
            players: prev.players.map(p => 
              p.id === data.exiled_player || p.name === data.exiled_player 
                ? { ...p, isAlive: false } 
                : p
            )
          }));
        }
        break;

      default:
        console.log('Unhandled game event:', event, data);
    }
  }, [handleGameStateUpdate]);

  const handleUserAction = useCallback((message) => {
    const { action, data, timeout } = message;

    switch (action) {
      case 'can_speak':
        // Clear any existing timeout
        if (speakTimeoutRef.current) {
          clearTimeout(speakTimeoutRef.current);
        }
        
        setGameState(prev => ({
          ...prev,
          interaction: {
            ...prev.interaction,
            can_speak: true,
            speaking_prompt: data.prompt || 'You can speak now!'
          }
        }));

        // Set timeout to disable speaking
        if (timeout) {
          speakTimeoutRef.current = setTimeout(() => {
            setGameState(prev => ({
              ...prev,
              interaction: { ...prev.interaction, can_speak: false, speaking_prompt: '' }
            }));
          }, timeout * 1000);
        }
        break;

      case 'request_vote':
        setGameState(prev => ({
          ...prev,
          voting: { ...prev.voting, active: true, voted_player: null }
        }));
        break;

      case 'request_target':
        setGameState(prev => ({
          ...prev,
          targetSelection: {
            active: true,
            action: data.action,
            options: data.options,
            prompt: data.prompt,
            icon: data.icon
          }
        }));
        break;

      default:
        console.log('Unhandled user action:', action, data);
    }
  }, []);

  const handleAnnouncement = useCallback((message) => {
    setGameState(prev => ({
      ...prev,
      announcements: [...prev.announcements, { 
        id: message.timestamp || Date.now(), 
        timestamp: new Date(message.timestamp).toLocaleTimeString(),
        ...message.announcement
      }]
    }));
  }, []);

  useEffect(() => {
    if (!room) return;

    const onParticipantConnected = (participant) => {
      if (!isMounted.current) return;
      console.log('Participant connected:', participant.identity);
      setParticipants(prev => prev.some(p => p.identity === participant.identity) ? prev : [...prev, participant]);
    };

    const onParticipantDisconnected = (participant) => {
      if (!isMounted.current) return;
      console.log('Participant disconnected:', participant.identity);
      setParticipants(prev => prev.filter((p) => p.identity !== participant.identity));
    };

    const onTrackSubscribed = (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio) {
        console.log('Audio track subscribed:', track.sid, 'for', participant.identity);
        setParticipantTracks(prev => {
          const newTracks = new Map(prev);
          const participantTracks = newTracks.get(participant.identity) || [];
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
            newTracks.set(participant.identity, participantTracks.filter(t => t.sid !== track.sid));
          }
          return newTracks;
        });
      }
    };

    const onDataReceived = (payload) => {
      if (!isMounted.current) return;
      try {
        const message = JSON.parse(new TextDecoder().decode(payload));
        handleMessage(message);
      } catch (error) {
        console.error('Failed to parse data message:', error);
      }
    };

    setParticipants(Array.from(room.remoteParticipants.values()));

    room
      .on(RoomEvent.ParticipantConnected, onParticipantConnected)
      .on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
      .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      .on(RoomEvent.DataReceived, onDataReceived);

    return () => {
      room
        .off(RoomEvent.ParticipantConnected, onParticipantConnected)
        .off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected)
        .off(RoomEvent.TrackSubscribed, onTrackSubscribed)
        .off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
        .off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, handleMessage]);

  const toggleMute = useCallback(async () => {
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!isMuted);
      setIsMuted(!isMuted);
    } catch (error) {
      console.error('Error toggling mute:', error);
    }
  }, [isMuted, room]);

  const sendMessage = useCallback((message) => {
    if (!room) return false;
    try {
      const payload = JSON.stringify(message);
      room.localParticipant.publishData(new TextEncoder().encode(payload), { reliable: true });
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }, [room]);

  const handleVote = useCallback((playerId) => {
    if (!room) return;
    sendMessage({ type: 'vote', target: playerId });
    setGameState(prev => ({
      ...prev,
      voting: {
        ...prev.voting,
        voted_player: playerId
      }
    }));
  }, [room, sendMessage]);

  const handleTargetSelection = useCallback((target) => {
    if (!room) return;
    sendMessage({ type: 'target_selection', target: target });
    setGameState(prev => ({
      ...prev,
      targetSelection: { active: false, action: null, options: [], prompt: '' }
    }));
  }, [room, sendMessage]);

  if (!room) {
    return (
      <div className="game-room-loading">
        <div className="loading-spinner"></div>
        <p>Connecting to room...</p>
      </div>
    );
  }

  // Combine local and remote participants and filter based on game state
  const allParticipants = [room.localParticipant, ...participants];
  const visibleParticipants = allParticipants.filter(p => 
    p && gameState.players.some(player => player.id === p.identity || player.name === p.identity)
  );

  return (
    <div className="game-room">
      <header className="game-header">
        <div className="header-content">
          <div className="room-info">
            <h2>{roomName}</h2>
            <div className="connection-status">
              <span className={`status-indicator ${room.state === 'connected' ? 'connected' : 'disconnected'}`}></span>
              <span className="status-text">{room.state === 'connected' ? 'Connected' : 'Disconnected'}</span>
            </div>
          </div>
          <div className="player-info">
            <span className="player-name">{playerName}</span>
            {gameState.currentPlayer.role && (
              <span className="player-role">{gameState.currentPlayer.role}</span>
            )}
          </div>
        </div>
      </header>

      <main className="game-content">
        <section className="participants-section">
          <div className="participants-grid">
            {visibleParticipants.map((participant) => {
              const tracks = Array.from(participantTracks.get(participant.identity) || []);
              const playerState = gameState.players.find(p => p.id === participant.identity || p.name === participant.identity);
              const isCurrentSpeaker = gameState.debate.current_speaker === participant.identity;
              
              return (
                <Participant
                  key={participant.identity}
                  audioTracks={tracks}
                  participant={participant}
                  isLocal={participant.identity === playerName}
                  isSpeaking={isCurrentSpeaker}
                  role={playerState?.role || 'villager'}
                  isAlive={playerState?.isAlive !== false}
                />
              );
            })}
          </div>
        </section>

        <section className="game-interface">
          <GameUI
            gameState={gameState}
            onVote={handleVote}
            onTargetSelection={handleTargetSelection}
            playerName={playerName}
            sendMessage={sendMessage}
          />
        </section>
      </main>

      <footer className="game-footer">
        <AudioControls
          isMuted={isMuted}
          onToggleMute={toggleMute}
          onDisconnect={() => room.disconnect()}
        />
      </footer>
    </div>
  );
};

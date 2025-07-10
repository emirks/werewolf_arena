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
  // ----- Local UI state -----
  const [participants, setParticipants] = useState([]);
  const [participantTracks, setParticipantTracks] = useState(new Map());
  const [isMuted, setIsMuted] = useState(false);

  // Game state
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

  const updateBasedOnType = (message) => {
    switch (message.update_type) {
      case 'day_phase_start':
        setGameState(prev => ({
          ...prev,
          phase: 'day',
          round: message.data?.round || prev.round,
          debate: {
            ...prev.debate,
            current_speaker: null,
            current_turn: 0,
            history: []
          },
          voting: {
            ...prev.voting,
            active: false,
            voted_player: null,
            votes: {}
          },
          interaction: {
            ...prev.interaction,
            can_speak: false
          }
        }));
        break;

      case 'night_phase_start':
        setGameState(prev => ({
          ...prev,
          phase: 'night',
          round: message.data?.round || prev.round,
          interaction: {
            ...prev.interaction,
            can_speak: false
          }
        }));
        break;

      case 'debate_update':
        const { speaker, dialogue, turn } = message.data || {};
        setGameState(prev => ({
          ...prev,
          phase: 'day',
          debate: {
            ...prev.debate,
            current_speaker: speaker,
            current_turn: turn || prev.debate.current_turn + 1,
            history: [...prev.debate.history, { speaker, dialogue, turn }],
            turns_left: Math.max(0, prev.debate.max_turns - (turn || prev.debate.current_turn + 1))
          }
        }));
        break;

      case 'voting_phase':
        setGameState(prev => ({
          ...prev,
          phase: 'voting',
          interaction: {
            ...prev.interaction,
            can_speak: false
          }
        }));
        break;

      case 'voting_started':
        setGameState(prev => ({
          ...prev,
          voting: {
            ...prev.voting,
            active: true,
            votes: {},
            voted_player: null
          }
        }));
        break;

      case 'vote_received':
        const { voter, target } = message.data || {};
        setGameState(prev => ({
          ...prev,
          voting: {
            ...prev.voting,
            votes: { ...prev.voting.votes, [voter]: target }
          }
        }));
        break;

      case 'voting_ended':
        setGameState(prev => ({
          ...prev,
          voting: {
            ...prev.voting,
            active: false,
            results: message.data?.votes || prev.voting.votes
          }
        }));
        break;

      case 'voting_results':
        setGameState(prev => ({
          ...prev,
          voting: {
            ...prev.voting,
            results: message.data?.results
          }
        }));
        break;

      case 'player_exiled':
        const exiledPlayer = message.data?.player;
        setGameState(prev => ({
          ...prev,
          players: prev.players.map(p => 
            p.id === exiledPlayer || p.name === exiledPlayer 
              ? { ...p, isAlive: false } 
              : p
          )
        }));
        break;
      default:
        break;
    }
  }

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
        console.log('Parsed message:', message);

        switch (message.type) {
          case 'game_state_update':
            if (message.game_state) {
              handleGameStateUpdate(message.game_state);
            }
            updateBasedOnType(message);

            break;

          case 'can_speak':
            const timeout = message.data?.timeout || 5;
            const prompt = message.data?.prompt || 'You can speak now!';
            
            // Clear any existing timeout
            if (speakTimeoutRef.current) {
              clearTimeout(speakTimeoutRef.current);
            }
            
            setGameState(prev => ({
              ...prev,
              interaction: {
                ...prev.interaction,
                can_speak: true,
                speaking_prompt: prompt
              }
            }));

            // Set timeout to disable speaking
            speakTimeoutRef.current = setTimeout(() => {
              setGameState(prev => ({
                ...prev,
                interaction: {
                  ...prev.interaction,
                  can_speak: false,
                  speaking_prompt: ''
                }
              }));
            }, timeout * 1000);
            break;

          case 'speaking_ended':
          case 'debate_turn':
            setGameState(prev => ({
              ...prev,
              interaction: {
                ...prev.interaction,
                can_speak: message.type === 'debate_turn',
                speaking_prompt: message.type === 'debate_turn' 
                  ? "It's your turn to speak!" 
                  : ''
              }
            }));
            break;

          case 'request_vote':
            setGameState(prev => ({
              ...prev,
              voting: {
                ...prev.voting,
                active: true,
                voted_player: null
              }
            }));
            break;

          case 'announcement':
            if (message.data?.text) {
              setGameState(prev => ({
                ...prev,
                announcements: [...prev.announcements, { 
                  id: Date.now(), 
                  message: message.data.text,
                  timestamp: new Date().toLocaleTimeString()
                }],
              }));
            }
            break;

          case 'request_target_selection':
            if (message.data) {
              setGameState(prev => ({
                ...prev,
                targetSelection: {
                  active: true,
                  action: message.data.action,
                  options: message.data.options,
                  prompt: message.data.prompt,
                },
              }));
            }
            break;

          default:
            console.warn('Unknown message type:', message.type);
        }
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
  }, [room, handleGameStateUpdate]);

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
          {playerName} ({gameState.currentPlayer.role})
          <span className={`connection-status ${room.state === 'connected' ? 'connected' : 'disconnected'}`}>
            {room.state === 'connected' ? '●' : '○'}
          </span>
        </div>
      </div>

      <div className="game-content">
        <div className="participants-grid">
          {participants.map((participant) => {
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

        <div className="game-ui-container">
          <GameUI
            gameState={gameState}
            onVote={handleVote}
            onTargetSelection={handleTargetSelection}
            playerName={playerName}
            sendMessage={sendMessage}
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
          {gameState.announcements.slice(-3).map(announcement => (
            <div key={announcement.id} className="announcement">
              <span className="announcement-time">{announcement.timestamp}</span>
              <span className="announcement-text">{announcement.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

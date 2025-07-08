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
    logs: [], // Add logs array to store game events
    announcements: [], // Add announcements array
    targetSelection: { // Add target selection state
      active: false,
      action: null,
      options: [],
      prompt: ''
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
        console.log('Received game message of type:', message.type, 'and update_type:', message.update_type, 'with data:', message.data, 'from', participant.identity);
        console.log('Full message structure:', JSON.stringify(message, null, 2)); // Debug full message
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

  // Helper functions for message handling
  const updateGameLogs = useCallback((logMessage) => {
    setGameState(prev => ({
      ...prev,
      logs: [...prev.logs, logMessage]
    }));
  }, []);

  const updateGamePhase = useCallback((phase, additionalData = {}) => {
    setGameState(prev => ({
      ...prev,
      phase,
      ...additionalData
    }));
  }, []);

  // Message handlers for different types
  const handleGameStateUpdate = useCallback((message) => {
    const { update_type, data } = message;

    switch (update_type) {
      case 'game_state':
        // Full game state update
        setGameState(prev => ({
          ...prev,
          ...data,
          players: data.players || prev.players,
          logs: [...prev.logs, '🎮 Game state updated']
        }));
        break;

      case 'day_phase_start':
        setGameState(prev => ({
          ...prev,
          players: data.players || prev.players,
          phase: 'day',
          currentTurn: data.round || 1,
          maxTurns: data.maxTurns || 5,
          logs: [...prev.logs, `🌅 Day ${data.round || 1} begins! Debate and vote to eliminate a player.`]
        }));
        setCurrentTurn(data.round || 1);
        break;

      case 'night_phase_start':
        setGameState(prev => ({
          ...prev,
          players: data.players || prev.players,
          phase: 'night',
          currentTurn: data.round || 1,
          logs: [...prev.logs, `🌙 Night ${data.round || 1} falls. Special roles, make your moves...`]
        }));
        setCurrentTurn(data.round || 1);
        break;

      case 'debate_update':
        console.log('Processing debate_update:', data);
        setGameState(prev => {
          const newLogs = [...prev.logs];

          if (data?.dialogue && data?.speaker) {
            newLogs.push(`💬 ${data.speaker}: ${data.dialogue}`);
            console.log('Added debate log:', `💬 ${data.speaker}: ${data.dialogue}`);
          }

          return {
            ...prev,
            currentTurn: data?.turn,
            currentSpeaker: data?.speaker,
            maxTurns: data?.maxTurns,
            logs: newLogs
          };
        });
        setCurrentTurn(data?.turn);

        // If it's the local player's turn, show speaking prompt
        if (data?.speaker === playerName) {
          setCanSpeak(true);
          const speakTime = data?.speakTime || 30;
          setTimeout(() => setCanSpeak(false), speakTime * 1000);
        }
        break;

      case 'voting_phase':
        updateGamePhase('voting');
        updateGameLogs(`🗳️ ${data.message || 'Voting phase has begun'}`);
        break;

      case 'voting_started':
        setIsVoting(true);
        setVotedPlayer(null);
        setGameState(prev => ({
          ...prev,
          phase: 'voting',
          voting: { ...prev.voting, isActive: true, votes: {} },
          logs: [...prev.logs, '🗳️ Voting has started!']
        }));
        break;

      case 'voting_ended':
        setIsVoting(false);
        setGameState(prev => ({
          ...prev,
          voting: { ...prev.voting, isActive: false },
          logs: [...prev.logs, '🗳️ Voting has ended.']
        }));
        break;

      case 'vote_received':
        const { voter, target } = data;
        if (voter === room.localParticipant.identity) {
          setVotedPlayer(target);
        }
        setGameState(prev => ({
          ...prev,
          voting: {
            ...prev.voting,
            votes: { ...prev.voting?.votes, [voter]: target }
          },
          logs: [...prev.logs, `🗳️ ${voter} voted for ${target}`]
        }));
        break;

      case 'voting_results':
        if (data.message) {
          updateGameLogs(`📊 ${data.message}`);
        }
        if (data.results) {
          const { vote_counts, most_voted, vote_count } = data.results;
          updateGameLogs(`📊 Results: ${Object.entries(vote_counts).map(([player, votes]) => `${player}: ${votes}`).join(', ')}`);
        }
        break;

      case 'player_exiled':
        if (data.player) {
          updateGameLogs(`⚰️ ${data.player} has been eliminated from the game!`);
          // Remove player from active players list
          setGameState(prev => ({
            ...prev,
            players: prev.players.map(p =>
              p.id === data.player ? { ...p, isAlive: false } : p
            )
          }));
        }
        break;

      case 'player_update':
        setGameState(prev => ({
          ...prev,
          players: prev.players.map(p =>
            p.id === data.id ? { ...p, ...data } : p
          )
        }));
        break;

      case 'phase_change':
        updateGamePhase(data.phase, { phaseData: data });
        updateGameLogs(`⏰ Phase changed to: ${data.phase}`);
        break;

      default:
        console.log('Unhandled game_state_update type:', update_type);
    }
  }, [playerName, room, updateGameLogs, updateGamePhase]);

  const handleDirectMessage = useCallback((message) => {
    const { type, data, prompt, options, action, timeout, text, timestamp } = message;

    switch (type) {
      case 'request_vote':
        // Show voting UI
        setIsVoting(true);
        setVotedPlayer(null);
        updateGameLogs(`🗳️ ${prompt || 'Please cast your vote'}`);
        // Could show available options in UI
        if (options) {
          console.log('Voting options:', options);
        }
        break;

      case 'can_speak':
        setCanSpeak(true);
        const speakTime = timeout ? timeout * 1000 : 5000;
        setTimeout(() => setCanSpeak(false), speakTime);
        updateGameLogs(`🎤 ${prompt || 'You can speak now'}`);
        break;

      case 'speaking_ended':
        setCanSpeak(false);
        updateGameLogs(`🔇 Speaking time ended`);
        break;

      case 'debate_turn':
        setCanSpeak(true);
        updateGameLogs(`💬 ${prompt || 'Your turn to speak'}`);
        break;

      case 'request_target_selection':
        // Show target selection UI
        updateGameLogs(`🎯 ${prompt || `Choose target for ${action}`}`);
        // Could show available options
        if (options) {
          console.log('Target selection options:', options);
          // Update UI to show target selection
          setGameState(prev => ({
            ...prev,
            targetSelection: {
              active: true,
              action: action,
              options: options,
              prompt: prompt
            }
          }));
        }
        break;

      case 'announcement':
        if (text) {
          updateGameLogs(`📢 ${text}`);
          setGameState(prev => ({
            ...prev,
            announcements: [...prev.announcements, {
              id: Date.now(),
              message: text,
              timestamp: timestamp || Date.now()
            }]
          }));
        }
        break;

      default:
        console.log('Unhandled direct message type:', type);
    }
  }, [updateGameLogs]);

  const handleGameMessage = useCallback((message) => {
    if (!isMounted.current) return;

    console.log('Handling game message:', message);

    try {
      // Route to appropriate handler based on message structure
      if (message.type === 'game_state_update') {
        handleGameStateUpdate(message);
      } else {
        // Handle direct message types
        handleDirectMessage(message);
      }
    } catch (error) {
      console.error('Error handling game message:', error, message);
      updateGameLogs(`❌ Error processing game message: ${error.message}`);
    }
  }, [handleGameStateUpdate, handleDirectMessage, updateGameLogs]);

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

  const handleTargetSelection = useCallback((target) => {
    if (!room) return;

    const message = {
      type: 'target_selection',
      target: target,
      player: room.localParticipant.identity
    };

    room.localParticipant.publishData(
      new TextEncoder().encode(JSON.stringify(message)),
      { reliable: true }
    );

    // Clear target selection UI
    setGameState(prev => ({
      ...prev,
      targetSelection: {
        active: false,
        action: null,
        options: [],
        prompt: ''
      }
    }));

    console.log('Target selection sent:', message);
  }, [room]);

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
            onTargetSelection={handleTargetSelection}
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

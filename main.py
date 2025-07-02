# Copyright 2024 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio
import os
import uuid
from typing import Dict, Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import logging

from livekit import api, rtc
from werewolf import game
from werewolf.model import Seer, Doctor, Villager, Werewolf, State
from werewolf.human_player import HumanPlayer
from werewolf.config import get_player_names

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Werewolf Game API")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global game instances
active_games: Dict[str, game.GameMaster] = {}

# LiveKit configuration
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "wss://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")

if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
    raise ValueError("LIVEKIT_API_KEY and LIVEKIT_API_SECRET environment variables must be set")

class JoinRoomRequest(BaseModel):
    player_name: str

class StartGameRequest(BaseModel):
    room_name: str
    player_name: str
    player_role: str
    villager_model: str = "gemini-2.0-flash-001"
    werewolf_model: str = "gemini-2.0-flash-001"

@app.post("/join-room")
async def join_room(request: JoinRoomRequest):
    """Generate LiveKit token for human player to join room."""
    try:
        # Generate unique room name if not provided
        room_name = f"werewolf_game_{uuid.uuid4().hex[:8]}"
        
        # Create LiveKit token
        token = api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        participant_id = f"user_{request.player_name}"
        
        token.with_identity(participant_id).with_name(request.player_name)
        token.with_grants(api.VideoGrants(
            room_join=True,
            room=room_name,
            can_publish=True,
            can_subscribe=True,
            can_publish_data=True
        ))
        
        jwt_token = token.to_jwt()
        
        return {
            "token": jwt_token,
            "url": LIVEKIT_URL,
            "room_name": room_name,
            "participant_id": participant_id
        }
        
    except Exception as e:
        logger.error(f"Error generating token: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate token: {str(e)}")

@app.post("/start-game")
async def start_game(request: StartGameRequest):
    """Start a new werewolf game with AI players."""
    try:
        # Check if game already exists for this room
        if request.room_name in active_games:
            raise HTTPException(status_code=400, detail="Game already exists for this room")
        
        # Initialize players
        player_names = get_player_names()
        import random
        random.shuffle(player_names)
        
        # Remove human player name from available names
        if request.player_name in player_names:
            player_names.remove(request.player_name)
        
        # Create AI players
        seer = Seer(name=player_names.pop(), model=request.villager_model)
        doctor = Doctor(name=player_names.pop(), model=request.villager_model)
        werewolves = [
            Werewolf(name=player_names.pop(), model=request.werewolf_model) for _ in range(2)
        ]
        villagers = [Villager(name=name, model=request.villager_model) for name in player_names[:3]]
        
        # Create human player
        human_player = HumanPlayer(
            name=request.player_name,
            role=request.player_role
        )
        room = rtc.Room()
        await human_player.setup_livekit_agent_for_user(room, request.room_name)
        
        # Replace one AI player with human based on role
        if request.player_role == "Seer":
            seer = human_player
        elif request.player_role == "Doctor":
            doctor = human_player
        elif request.player_role == "Werewolf":
            werewolves[0] = human_player
        else:  # Villager
            villagers[0] = human_player
        
        # Create game state
        all_ai_players = [seer, doctor] + werewolves + villagers
        ai_players = [p for p in all_ai_players if not isinstance(p, HumanPlayer)]
        for player in ai_players:
            await player.setup_livekit_session(room, request.room_name)
        
        # Initialize game view for all players
        current_player_names = [p.name for p in all_ai_players]
        live_werewolves = [p for p in all_ai_players if p.role == "Werewolf"]
        
        for player in all_ai_players:
            other_wolf = None
            if player.role == "Werewolf":
                other_wolf_player = next(
                    (w for w in live_werewolves if w.name != player.name), None
                )
                if other_wolf_player:
                    other_wolf = other_wolf_player.name
            
            player.initialize_game_view(
                current_players=current_player_names,
                round_number=0,
                other_wolf=other_wolf,
            )
        
        # Create game state
        state = State(
            villagers=[p for p in all_ai_players if p.role == "Villager"],
            werewolves=[p for p in all_ai_players if p.role == "Werewolf"],
            seer=seer,
            doctor=doctor,
            session_id=request.room_name,
        )
        
        # Create game master
        gamemaster = game.GameMaster(state, num_threads=2, room_name=request.room_name)
        
        # # Setup LiveKit room
        # await gamemaster.setup_livekit_room()
        
        # Store active game
        active_games[request.room_name] = gamemaster
        
        # Start the game in background
        asyncio.create_task(run_game_async(request.room_name, gamemaster))
        
        return {
            "message": "Game started successfully",
            "room_name": request.room_name,
            "players": [p.name for p in all_ai_players],
            "human_player": request.player_name,
            "human_role": request.player_role
        }
        
    except Exception as e:
        logger.error(f"Error starting game: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to start game: {str(e)}")

async def run_game_async(room_name: str, gamemaster: game.GameMaster):
    """Run the game asynchronously in the background."""
    try:
        winner = await gamemaster.run_game()
        logger.info(f"Game {room_name} completed. Winner: {winner}")
    except Exception as e:
        logger.error(f"Error running game {room_name}: {e}")
    finally:
        # Clean up
        if room_name in active_games:
            del active_games[room_name]

@app.get("/game-status/{room_name}")
async def get_game_status(room_name: str):
    """Get the current status of a game."""
    if room_name not in active_games:
        raise HTTPException(status_code=404, detail="Game not found")
    
    gamemaster = active_games[room_name]
    
    return {
        "room_name": room_name,
        "current_round": gamemaster.current_round_num,
        "winner": gamemaster.state.winner,
        "players": list(gamemaster.state.players.keys()),
        "active": room_name in active_games
    }

# Serve static files
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

import asyncio
import os
import uuid
import random
from typing import Dict, Any, List, Set
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import logging

from livekit import api
from werewolf import game
from werewolf.model import (
    State,
    SEER,
    DOCTOR,
    WEREWOLF,
    VILLAGER,
    Seer,
    Doctor,
    Werewolf,
    Villager,
)
from werewolf.pipecat_human_player import PipecatHumanPlayer
from werewolf.pipecat_ai_player import PipecatAIPlayer
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

# Global room and game management
active_games: Dict[str, game.GameMaster] = {}
rooms: Dict[str, Dict[str, Any]] = {}  # room_id -> room_info
room_id_to_name: Dict[str, str] = {}  # room_id -> room_name mapping

# LiveKit configuration
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "wss://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")

if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
    raise ValueError(
        "LIVEKIT_API_KEY and LIVEKIT_API_SECRET environment variables must be set"
    )


class CreateRoomRequest(BaseModel):
    room_name: str
    creator_name: str


class JoinRoomRequest(BaseModel):
    room_id: str
    player_name: str


class SetReadyRequest(BaseModel):
    room_id: str
    player_name: str
    is_ready: bool


class StartGameRequest(BaseModel):
    room_id: str
    player_names: List[str]
    villager_model: str = "gemini-2.0-flash-001"
    werewolf_model: str = "gemini-2.0-flash-001"


def generate_room_id() -> str:
    """Generate a unique 6-character room ID."""
    import string
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))


@app.post("/create-room")
async def create_room(request: CreateRoomRequest):
    """Create a new room and return room ID for sharing."""
    try:
        # Generate unique room ID
        room_id = generate_room_id()
        while room_id in rooms:  # Ensure uniqueness
            room_id = generate_room_id()
        
        # Generate unique room name for LiveKit
        room_name = f"werewolf_game_{uuid.uuid4().hex[:8]}"
        
        # Store room information
        rooms[room_id] = {
            "room_name": room_name,
            "creator": request.creator_name,
            "players": {request.creator_name: {"ready": False}},
            "created_at": asyncio.get_event_loop().time(),
            "game_started": False
        }
        room_id_to_name[room_id] = room_name
        
        logger.info(f"Created room {room_id} ({room_name}) by {request.creator_name}")
        
        return {
            "room_id": room_id,
            "room_name": room_name,
            "creator": request.creator_name,
            "message": "Room created successfully"
        }
    
    except Exception as e:
        logger.error(f"Error creating room: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create room: {str(e)}")


@app.post("/join-room")
async def join_room(request: JoinRoomRequest):
    """Join an existing room using room ID and get LiveKit token."""
    try:
        # Check if room exists
        if request.room_id not in rooms:
            raise HTTPException(status_code=404, detail="Room not found")
        
        room_info = rooms[request.room_id]
        
        # Check if game has already started
        if room_info["game_started"]:
            raise HTTPException(status_code=400, detail="Game has already started")
        
        # Check if player name is already taken by someone other than the creator
        if request.player_name in room_info["players"] and request.player_name != room_info["creator"]:
            raise HTTPException(status_code=400, detail="Player name already taken in this room")
        
        # Add player to room if not already present
        if request.player_name not in room_info["players"]:
            room_info["players"][request.player_name] = {"ready": False}
        
        # Create LiveKit token
        token = api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        token.with_identity(request.player_name).with_name(request.player_name)
        token.with_grants(
            api.VideoGrants(
                room_join=True,
                room=room_info["room_name"],
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        
        jwt_token = token.to_jwt()
        
        logger.info(f"Player {request.player_name} joined room {request.room_id}")
        
        return {
            "token": jwt_token,
            "url": LIVEKIT_URL,
            "room_name": room_info["room_name"],
            "room_id": request.room_id,
            "participant_id": request.player_name,
            "players": list(room_info["players"].keys()),
            "creator": room_info["creator"]
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error joining room: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to join room: {str(e)}")


@app.post("/set-ready")
async def set_ready(request: SetReadyRequest):
    """Set player ready status in a room."""
    try:
        if request.room_id not in rooms:
            raise HTTPException(status_code=404, detail="Room not found")
        
        room_info = rooms[request.room_id]
        
        if request.player_name not in room_info["players"]:
            raise HTTPException(status_code=404, detail="Player not found in room")
        
        room_info["players"][request.player_name]["ready"] = request.is_ready
        
        logger.info(f"Player {request.player_name} set ready to {request.is_ready} in room {request.room_id}")
        
        return {
            "message": "Ready status updated",
            "players": room_info["players"]
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting ready status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to set ready status: {str(e)}")


@app.get("/room-status/{room_id}")
async def get_room_status(room_id: str):
    """Get current room status including players and ready states."""
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    
    room_info = rooms[room_id]
    all_ready = all(player_info["ready"] for player_info in room_info["players"].values())
    
    return {
        "room_id": room_id,
        "room_name": room_info["room_name"],
        "creator": room_info["creator"],
        "players": room_info["players"],
        "all_ready": all_ready,
        "player_count": len(room_info["players"]),
        "game_started": room_info["game_started"]
    }


@app.post("/start-game")
async def start_game(request: StartGameRequest):
    """Start a new werewolf game with multiple human players."""
    try:
        # Check if room exists
        if request.room_id not in rooms:
            raise HTTPException(status_code=404, detail="Room not found")
        
        room_info = rooms[request.room_id]
        room_name = room_info["room_name"]
        
        # Check if game already exists for this room
        if room_name in active_games:
            raise HTTPException(status_code=400, detail="Game already exists for this room")
        
        # Check if all players are ready
        all_ready = all(room_info["players"][name]["ready"] for name in request.player_names)
        if not all_ready:
            raise HTTPException(status_code=400, detail="Not all players are ready")
        
        # Mark game as started
        room_info["game_started"] = True
        
        # Get available player names for AI
        available_ai_names = get_player_names()
        random.shuffle(available_ai_names)
        
        # Remove human player names from available AI names
        for human_name in request.player_names:
            if human_name in available_ai_names:
                available_ai_names.remove(human_name)
        
        # Create human players
        human_players = []
        for player_name in request.player_names:
            human_player = PipecatHumanPlayer(name=player_name, role=VILLAGER)  # Role will be assigned later
            # await human_player.setup_pipecat_pipeline(room_name)
            human_players.append(human_player)
        
        # Calculate remaining AI players needed
        total_players_needed = 8  # Standard werewolf game size
        ai_players_needed = max(0, total_players_needed - len(human_players))
        
        # Create AI players for remaining slots
        ai_players = []
        if ai_players_needed > 0:
            for i in range(min(ai_players_needed, len(available_ai_names))):
                # Create AI player as Villager initially (role will be reassigned later)
                ai_player = Villager(
                    name=available_ai_names[i],
                    model=request.villager_model
                )
                # await ai_player.setup_pipecat_pipeline(room_name)
                ai_players.append(ai_player)
        
        # Combine all players
        all_players = human_players + ai_players
        
        # Assign roles randomly
        roles_to_assign = [SEER, DOCTOR, WEREWOLF, WEREWOLF] + [VILLAGER] * (len(all_players) - 4)
        random.shuffle(roles_to_assign)
        
        # Create role-specific players and assign roles
        final_players = []
        for i, player in enumerate(all_players):
            if i < len(roles_to_assign):
                role = roles_to_assign[i]
                name = player.name
                is_human = isinstance(player, PipecatHumanPlayer)
                model = request.villager_model if role != WEREWOLF else request.werewolf_model
                
                if is_human:
                    new_player = PipecatHumanPlayer(name=name, role=role)
                    await new_player.setup_pipecat_pipeline(room_name)
                else:
                    if role == SEER:
                        new_player = Seer(name=name, model=model)
                    elif role == DOCTOR:
                        new_player = Doctor(name=name, model=model)
                    elif role == WEREWOLF:
                        new_player = Werewolf(name=name, model=model)
                    else:  # VILLAGER
                        new_player = Villager(name=name, model=model)
                    await new_player.setup_pipecat_pipeline(room_name)
                
                final_players.append(new_player)
        
        # Organize players by role
        seer = next((p for p in final_players if p.role == SEER), None)
        doctor = next((p for p in final_players if p.role == DOCTOR), None)
        werewolves = [p for p in final_players if p.role == WEREWOLF]
        villagers = [p for p in final_players if p.role == VILLAGER]
        
        if not seer or not doctor or len(werewolves) < 2:
            raise HTTPException(status_code=500, detail="Failed to assign required roles")
        
        # Initialize game view for all players
        current_player_names = [p.name for p in final_players]
        
        for player in final_players:
            other_wolf = None
            if player.role == WEREWOLF:
                other_wolf_player = next((w for w in werewolves if w.name != player.name), None)
                if other_wolf_player:
                    other_wolf = other_wolf_player.name
            
            player.initialize_game_view(
                current_players=current_player_names,
                round_number=0,
                other_wolf=other_wolf,
            )
        
        # Create game state
        state = State(
            villagers=villagers,
            werewolves=werewolves,
            seer=seer,
            doctor=doctor,
            session_id=room_name,
        )
        
        # Create game master
        gamemaster = game.GameMaster(state, num_threads=2, room_name=room_name)
        
        # Store active game
        active_games[room_name] = gamemaster
        
        # Start the game in background
        asyncio.create_task(run_game_async(room_name, gamemaster))
        
        # Return game start information
        player_roles = {player.name: player.role for player in final_players}
        
        logger.info(f"Game started in room {request.room_id} with players: {request.player_names}")
        
        return {
            "message": "Game started successfully",
            "room_id": request.room_id,
            "room_name": room_name,
            "players": current_player_names,
            "human_players": request.player_names,
            "player_roles": player_roles,
        }
    
    except HTTPException:
        raise
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
        "active": room_name in active_games,
    }


# Serve static files
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
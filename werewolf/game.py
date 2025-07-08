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

"""Werewolf game."""

import asyncio
import logging
import os
import random
from collections import Counter
from typing import List, Optional, Tuple, Any

import tqdm
from livekit import api

from werewolf.config import MAX_DEBATE_TURNS, RUN_SYNTHETIC_VOTES
from werewolf.model import LmLog, Round, RoundLog, State
from werewolf.pipecat_human_player import PipecatHumanPlayer

# Initialize logger
logger = logging.getLogger(__name__)

def get_max_bids(d):
    """Gets all the keys with the highest value in the dictionary."""
    max_value = max(d.values())
    max_keys = [key for key, value in d.items() if value == max_value]
    return max_keys


class GameMaster:

    def __init__(
        self,
        state: State,
        num_threads: int = 1,
        room_name: str = None,
    ) -> None:
        """Initialize the Werewolf game.

        Args:
        """
        self.state = state
        self.current_round_num = len(self.state.rounds) if self.state.rounds else 0
        self.num_threads = num_threads
        self.logs: List[RoundLog] = []
        self.human_player: PipecatHumanPlayer | None = None
        self.room_name = room_name or f"werewolf_game_{state.session_id}"
        
        # Find human player
        for p in self.state.players.values():
            tqdm.tqdm.write(f"Player: {p.name}, Type: {type(p)}")
            if isinstance(p, PipecatHumanPlayer):
                self.human_player = p
                tqdm.tqdm.write(f"Human player found: {self.human_player.name}")
                break
                
        # Setup LiveKit API for room management
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET")
        
    # async def setup_livekit_room(self):
    #     """Setup LiveKit room for all players."""
    #     if not self.livekit_api_key or not self.livekit_api_secret:
    #         tqdm.tqdm.write("LiveKit credentials not found, running without LiveKit")
    #         return
            
    #     try:
    #         # Create room if it doesn't exist
    #         livekit_api = api.LiveKitAPI(
    #             url=os.getenv("LIVEKIT_URL", "wss://localhost:7880"),
    #             api_key=self.livekit_api_key,
    #             api_secret=self.livekit_api_secret
    #         )
            
    #         # Setup human player first if exists
    #         if self.human_player:
    #             token = self.human_player.setup_livekit_for_user(self.room_name)
    #             tqdm.tqdm.write(f"Human player {self.human_player.name} LiveKit token ready")
            
    #         tqdm.tqdm.write(f"LiveKit room '{self.room_name}' setup complete")
            
    #     except Exception as e:
    #         tqdm.tqdm.write(f"Error setting up LiveKit room: {e}")

    async def broadcast_to_human(self, message_type: str, data=None):
        """Broadcast message to human player if present."""
        if self.human_player:
            if message_type == "announcement":
                await self.human_player.broadcast_announcement(data)
            elif message_type == "game_state":
                await self.human_player.send_game_state_update("game_state", data)

    @property
    def this_round(self) -> Round:
        return self.state.rounds[self.current_round_num]

    @property
    def this_round_log(self) -> RoundLog:
        return self.logs[self.current_round_num]

    async def eliminate(self):
        """Werewolves choose a player to eliminate."""
        werewolves_alive = [
            w for w in self.state.werewolves if w.name in self.this_round.players
        ]
        wolf = random.choice(werewolves_alive)
        eliminated, log = await wolf.eliminate()
        self.this_round_log.eliminate = log
        if eliminated is not None:
            self.this_round.eliminated = eliminated
            tqdm.tqdm.write(f"{wolf.name} eliminated {eliminated}")
            for wolf in werewolves_alive:
                wolf._add_observation(
                    "During the"
                    f" night, {'we' if len(werewolves_alive) > 1 else 'I'} decided to"
                    f" eliminate {eliminated}."
                )
        else:
            raise ValueError("Eliminate did not return a valid player.")

    async def protect(self):
        """Doctor chooses a player to protect."""
        if self.state.doctor.name not in self.this_round.players:
            return  # Doctor no longer in the game

        protect, log = await self.state.doctor.save()
        self.this_round_log.protect = log

        if protect is not None:
            self.this_round.protected = protect
            tqdm.tqdm.write(f"{self.state.doctor.name} protected {protect}")
        else:
            raise ValueError("Protect did not return a valid player.")

    async def unmask(self):
        """Seer chooses a player to unmask."""
        if self.state.seer.name not in self.this_round.players:
            return  # Seer no longer in the game

        unmask, log = await self.state.seer.unmask()
        tqdm.tqdm.write(f"{self.state.seer.name} unmasked {unmask}")
        self.this_round_log.investigate = log

        if unmask is not None:
            self.this_round.unmasked = unmask
            self.state.seer.reveal_and_update(unmask, self.state.players[unmask].role)
        else:
            raise ValueError("Unmask function did not return a valid player.")

    async def _get_bid(self, player_name):
        """Gets the bid for a specific player."""
        player = self.state.players[player_name]
        bid, log = await player.bid()
        if bid is None:
            raise ValueError(
                f"{player_name} did not return a valid bid. Find the raw response"
                " in the `bid` field in the log"
            )
        if bid > 1:
            tqdm.tqdm.write(f"{player_name} bid: {bid}")
        return bid, log

    async def get_next_speaker(self):
        """Determine the next speaker based on bids."""
        previous_speaker, previous_dialogue = (
            self.this_round.debate[-1] if self.this_round.debate else (None, None)
        )

        ai_players_to_bid = [
            player_name
            for player_name in self.this_round.players
            if player_name != previous_speaker
            and (not self.human_player or player_name != self.human_player.name)
        ]

        if not ai_players_to_bid:
            return None

        bid_coroutines = [self._get_bid(player_name) for player_name in ai_players_to_bid]
        bid_results = await asyncio.gather(*bid_coroutines)
        bid_log = []
        bids = {}
        for i, player_name in enumerate(ai_players_to_bid):
            bid, log = bid_results[i]
            bids[player_name] = bid
            bid_log.append((player_name, log))

        self.this_round.bids.append(bids)
        self.this_round_log.bid.append(bid_log)

        potential_speakers = get_max_bids(bids)
        # Prioritize mentioned speakers if there's previous dialogue
        if previous_dialogue:
            potential_speakers.extend(
                [name for name in potential_speakers if name in previous_dialogue]
            )

        random.shuffle(potential_speakers)
        return random.choice(potential_speakers)

    async def run_summaries(self):
        """Collect summaries from players after the debate."""

        players = self.this_round.players
        summary_coroutines = [self.state.players[name].summarize() for name in players]
        summary_results = await asyncio.gather(*summary_coroutines)

        summaries = {}
        summary_log = []
        for i, player_name in enumerate(players):
            summary, log = summary_results[i]
            if summary is not None:
                summaries[player_name] = summary
            summary_log.append((player_name, log))

        self.this_round.summaries = summaries
        self.this_round_log.summaries = summary_log

    async def run_day_phase(self):
        """Run the day phase which consists of the debate and voting."""
        
        # Reset human player vote at start of day phase
        if self.human_player:
            self.human_player.reset_vote()
            await self.human_player.send_game_state_update("day_phase_start", {
                "round": self.current_round_num,
                "players": self.this_round.players,
                "phase": "debate"
            })

        debate_ended_early = False
        for idx in range(MAX_DEBATE_TURNS):
            next_speaker = None
            human_can_speak = (
                self.human_player and self.human_player.name in self.this_round.players
            )

            if human_can_speak:
                # Check if human player wants to speak using LiveKit bid system
                bid, log = await self.human_player.bid()
                self.this_round_log.bid.append([(self.human_player.name, log)])
                
                if bid > 0:
                    next_speaker = self.human_player.name

            if next_speaker is None:
                next_speaker = await self.get_next_speaker()

            if not next_speaker:
                tqdm.tqdm.write("No one else wishes to speak. The debate concludes.")
                debate_ended_early = True
                break

            player = self.state.players[next_speaker]
            dialogue, log = await player.debate()
            if dialogue is None:
                raise ValueError(
                    f"{next_speaker} did not return a valid dialouge from debate()."
                )

            self.this_round_log.debate.append((next_speaker, log))
            self.this_round.debate.append([next_speaker, dialogue])
            tqdm.tqdm.write(f"{next_speaker} ({player.role}): {dialogue}")

            for name in self.this_round.players:
                player = self.state.players[name]
                if player.gamestate:
                    player.gamestate.update_debate(next_speaker, dialogue)
                else:
                    raise ValueError(f"{name}.gamestate needs to be initialized.")

            # Update human player with latest debate
            if self.human_player:
                await self.human_player.send_game_state_update("debate_update", {
                    "speaker": next_speaker,
                    "dialogue": dialogue,
                    "turn": len(self.this_round.debate)
                })

            # Synthetic votes are for AI-only simulations to see how votes shift.
            # This should not run during interactive play.
            if RUN_SYNTHETIC_VOTES and not self.human_player:
                votes, vote_logs = await self.run_voting()
                self.this_round.votes.append(votes)
                self.this_round_log.votes.append(vote_logs)

        # The definitive vote happens once the debate is over.
        # If we were running synthetic votes, the final vote is already captured.
        if not RUN_SYNTHETIC_VOTES or self.human_player:
            tqdm.tqdm.write("\nThe debate has concluded. Time to vote.")
            if self.human_player:
                await self.human_player.send_game_state_update("voting_phase", {
                    "phase": "voting",
                    "message": "The debate has concluded. Time to vote."
                })
            votes, vote_logs = await self.run_voting()
            self.this_round.votes.append(votes)
            self.this_round_log.votes.append(vote_logs)

        for player, vote in self.this_round.votes[-1].items():
            tqdm.tqdm.write(f"{player} voted to remove {vote}")

    async def run_voting(self):
        """Conduct a vote among players to exile someone."""
        vote_log = []
        votes = {}
        players = self.this_round.players
        
        # Notify all players that voting has started
        if self.human_player:
            await self.human_player.send_game_state_update("voting_started", {
                "players": [{"id": p, "name": p} for p in players],
                "message": "Voting has started. Please select a player to eliminate."
            })
        
        # Collect votes from all players
        vote_coroutines = []
        for name in players:
            player = self.state.players[name]
            if isinstance(player, PipecatHumanPlayer):
                # For human players, wait for their vote through the UI
                vote_coroutines.append(self._collect_human_vote(player))
            else:
                # For AI players, get their vote directly
                vote_coroutines.append(player.vote())
        
        # Wait for all votes to be cast with a timeout
        try:
            vote_results = await asyncio.wait_for(
                asyncio.gather(*vote_coroutines, return_exceptions=True),
                timeout=60  # 60 second timeout for voting
            )
            
            # Process the votes
            for i, result in enumerate(vote_results):
                player_name = players[i]
                if isinstance(result, Exception):
                    logger.error(f"Error getting vote from {player_name}: {result}")
                    continue
                    
                vote, log = result
                vote_log.append((player_name, vote, log))
                
                if vote is not None:
                    votes[player_name] = vote
                    
                    # Notify about the vote
                    if self.human_player:
                        await self.human_player.send_game_state_update("vote_received", {
                            "voter": player_name,
                            "target": vote
                        })
        except asyncio.TimeoutError:
            logger.warning("Voting timed out, proceeding with current votes")
            
        # Notify that voting has ended
        if self.human_player:
            await self.human_player.send_game_state_update("voting_ended", {
                "votes": votes,
                "message": "Voting has concluded."
            })
            
        return votes, vote_log
        
    async def _collect_human_vote(self, human_player):
        """Helper method to collect vote from human player with timeout."""
        try:
            # This will wait for the human to vote through the UI
            vote, log = await asyncio.wait_for(
                human_player.vote(),
                timeout=30  # 30 seconds for human to vote
            )
            return vote, log
        except asyncio.TimeoutError:
            logger.warning(f"{human_player.name} did not vote in time")
            return None, LmLog(
                prompt="VOTE_TIMEOUT",
                raw_resp="",
                result={"error": "Vote not received in time"}
            )

    async def exile(self):
        """Exile the player who received the most votes."""
        if not self.this_round.votes:
            logger.warning("No votes recorded in this round")
            return
            
        vote_counts = Counter(self.this_round.votes[-1].values())
        if not vote_counts:
            logger.warning("No valid votes to count")
            return
            
        most_voted, vote_count = vote_counts.most_common(1)[0]
        total_voters = len([p for p in self.this_round.players if p in self.this_round.votes[-1]])
        
        # Notify about the voting results
        if self.human_player:
            await self.human_player.send_game_state_update("voting_results", {
                "results": {
                    "vote_counts": dict(vote_counts),
                    "most_voted": most_voted,
                    "vote_count": vote_count,
                    "total_voters": total_voters,
                    "majority_needed": total_voters / 2
                },
                "message": f"Voting results: {most_voted} received {vote_count} votes"
            })

        if vote_count > total_voters / 2:
            self.this_round.exiled = most_voted

        if self.this_round.exiled is not None:
            exiled_player = self.this_round.exiled
            # Notify about the exile
            if self.human_player:
                await self.human_player.send_game_state_update("player_exiled", {
                    "player": exiled_player,
                    "votes": vote_count
                })
            announcement = (
                f"The majority voted to remove {exiled_player} from the game."
            )
            # Update gamestate for all players first
            for name in self.this_round.players:
                player = self.state.players[name]
                if player.gamestate:
                    player.gamestate.remove_player(exiled_player)
            # Then remove from the round's active players
            self.this_round.players.remove(exiled_player)
        else:
            announcement = (
                "A majority vote was not reached, so no one was removed from the"
                " game."
            )

        # Announce to remaining players
        for name in self.this_round.players:
            player = self.state.players[name]
            player.add_announcement(announcement)

        tqdm.tqdm.write(announcement)
        
        # Broadcast to human player through LiveKit
        await self.broadcast_to_human("announcement", announcement)

    async def resolve_night_phase(self):
        """Resolve elimination and protection during the night phase."""
        eliminated_player = self.this_round.eliminated
        protected_player = self.this_round.protected

        if eliminated_player and eliminated_player != protected_player:
            announcement = (
                f"The Werewolves removed {eliminated_player} from the game during the"
                " night."
            )
            # Update gamestate for all players first
            for name in self.this_round.players:
                player = self.state.players[name]
                if player.gamestate:
                    player.gamestate.remove_player(eliminated_player)
            # Then remove from the round's active players
            self.this_round.players.remove(eliminated_player)
        else:
            announcement = "No one was removed from the game during the night."

        tqdm.tqdm.write(announcement)

        # Announce to remaining players
        for name in self.this_round.players:
            player = self.state.players[name]
            player.add_announcement(announcement)
            
        # Broadcast to human player through LiveKit
        await self.broadcast_to_human("announcement", announcement)

    async def run_round(self):
        """Run a single round of the game."""
        self.state.rounds.append(Round())
        self.logs.append(RoundLog())

        self.this_round.players = (
            list(self.state.players.keys())
            if self.current_round_num == 0
            else self.state.rounds[self.current_round_num - 1].players.copy()
        )

        for action, message in [
            (
                self.eliminate,
                "The Werewolves are picking someone to remove from the game.",
            ),
            (self.protect, "The Doctor is protecting someone."),
            (self.unmask, "The Seer is investigating someone."),
            (self.resolve_night_phase, ""),
            (self.check_for_winner, "Checking for a winner after Night Phase."),
            (self.run_day_phase, "The Players are debating and voting."),
            (self.exile, ""),
            (self.check_for_winner, "Checking for a winner after Day Phase."),
            (self.run_summaries, "The Players are summarizing the debate."),
        ]:
            tqdm.tqdm.write(message)
            if asyncio.iscoroutinefunction(action):
                await action()
            else:
                action()

            if self.state.winner:
                tqdm.tqdm.write(f"Round {self.current_round_num} is complete.")
                self.this_round.success = True
                return

        tqdm.tqdm.write(f"Round {self.current_round_num} is complete.")
        self.this_round.success = True

    def get_winner(self) -> str:
        """Determine the winner of the game."""
        active_wolves = set(self.this_round.players) & set(
            w.name for w in self.state.werewolves
        )
        active_villagers = set(self.this_round.players) - active_wolves
        if len(active_wolves) >= len(active_villagers):
            return "Werewolves"
        return "Villagers" if not active_wolves else ""

    def check_for_winner(self):
        """Check if there is a winner and update the state accordingly."""
        self.state.winner = self.get_winner()
        if self.state.winner:
            tqdm.tqdm.write(f"The winner is {self.state.winner}!")

    async def run_game(self) -> str:
        """Run the entire Werewolf game and return the winner."""
        while not self.state.winner:
            tqdm.tqdm.write(f"STARTING ROUND: {self.current_round_num}")
            await self.run_round()
            for name in self.this_round.players:
                if self.state.players[name].gamestate:
                    self.state.players[name].gamestate.round_number = (
                        self.current_round_num + 1
                    )
                    self.state.players[name].gamestate.clear_debate()
            self.current_round_num += 1

        tqdm.tqdm.write("Game is complete!")
        return self.state.winner

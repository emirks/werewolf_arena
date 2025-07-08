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


from openai import AsyncOpenAI
import os

from typing import Any, Optional
import google
from google import genai
from anthropic import AsyncAnthropicVertex

from dotenv import load_dotenv

load_dotenv(override=True)

# Initialize OpenAI client
client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

# Initialize Cerebras client
cerebras_client = AsyncOpenAI(
    base_url="https://api.cerebras.ai/v1",
    api_key=os.environ.get("CEREBRAS_API_KEY", "")
)

DEFAULT_MODEL = "openai"

DEFAULT_OPENAI_MODEL = "gpt-4.1-mini-2025-04-14"
DEFAULT_CLAUDE_MODEL = "claude-3-5-sonnet-20240620"
DEFAULT_CEREBRAS_MODEL = "llama-4-scout-17b-16e-instruct"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite-preview-06-17"

# Initialize Google GenAI client
genai_client = genai.Client(api_key=os.environ.get("GOOGLE_API_KEY"))


async def generate(**kwargs):
    if DEFAULT_MODEL == "openai":
        return await generate_openai(**kwargs)
    elif DEFAULT_MODEL == "claude":
        return await generate_authropic(**kwargs)
    elif DEFAULT_MODEL == "cerebras" or DEFAULT_MODEL == "llama":
        return await generate_cerebras(**kwargs)
    elif DEFAULT_MODEL == "gemini":
        return await generate_genai(**kwargs)
    else:
        raise ValueError(f"Unknown model: {DEFAULT_MODEL}")


# openai
async def generate_openai(
    prompt: str, json_mode: bool = True, temperature: float = 1.0, **kwargs
):
    response_format = {"type": "text"}
    if json_mode:
        response_format = {"type": "json_object"}
    response = await client.chat.completions.create(
        messages=[{"role": "user", "content": prompt}],
        response_format=response_format,
        model=DEFAULT_OPENAI_MODEL,
        temperature=temperature,
    )

    txt = response.choices[0].message.content
    return txt


# anthropic
async def generate_authropic(prompt: str, **kwargs):
    # For local development, run `gcloud auth application-default login` first to
    # create the application default credentials, which will be picked up
    # automatically here.
    _, project_id = google.auth.default()
    client = AsyncAnthropicVertex(region="us-east5", project_id=project_id)

    response = await client.messages.create(
        model=DEFAULT_CLAUDE_MODEL, messages=[{"role": "user", "content": prompt}], max_tokens=1024
    )

    return response.content[0].text


# google genai (replacing vertexai)
async def generate_genai(
    prompt: str,
    temperature: float = 0.7,
    json_mode: bool = True,
    json_schema: dict[str, Any] | None = None,
    **kwargs,
) -> str:
    """Generates text content using Google GenAI client."""
    
    config = {
        "temperature": temperature,
    }
    
    # Add JSON mode configuration if requested
    if json_mode or json_schema is not None:
        config["response_mime_type"] = "application/json"
        if json_schema is not None:
            config["response_schema"] = json_schema

    try:
        response = await genai_client.aio.models.generate_content(
            model=DEFAULT_GEMINI_MODEL,
            contents=prompt,
            config=config
        )
        
        return response.text
        
    except Exception as e:
        # Fallback without JSON constraints if there's an error
        try:
            response = await genai_client.aio.models.generate_content(
                model=DEFAULT_GEMINI_MODEL,
                contents=prompt,
                config={"temperature": temperature}
            )
            return response.text
        except Exception as fallback_error:
            raise Exception(f"GenAI generation failed: {fallback_error}")


async def generate_cerebras(
    prompt: str,
    temperature: float = 0.7,
    json_mode: bool = False,
    **kwargs,
) -> str:
    """
    Generate text using Cerebras API with the specified model.
    
    Args:
        model: The model to use (e.g., 'llama-4-scout-17b-16e-instruct')
        prompt: The input prompt
        temperature: Controls randomness (0.0 to 1.0)
        json_mode: If True, enables JSON mode (note: not compatible with streaming)
        **kwargs: Additional parameters for the API call
        
    Returns:
        The generated text response
        
    Note:
        Cerebras API doesn't support the following OpenAI features:
        - frequency_penalty
        - logit_bias
        - presence_penalty
        - parallel_tool_calls
        - service_tier
        
        JSON mode is not compatible with streaming.
    """
    
    # Prepare parameters
    params = {
        "model": DEFAULT_CEREBRAS_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": max(0, min(1.0, temperature)),  # Clamp to 0-1 range
    }
    
    # Add JSON mode if requested
    if json_mode:
        if kwargs.get("stream", False):
            raise ValueError("JSON mode is not compatible with streaming in Cerebras API")
        params["response_format"] = {"type": "json_object"}
    
    # Filter out unsupported parameters
    unsupported_params = [
        'frequency_penalty',
        'logit_bias',
        'presence_penalty',
        'parallel_tool_calls',
        'service_tier',
        'response_schema',
        'disable_recitation',
        'disable_safety_check'
    ]
    for param in unsupported_params:
        if param in kwargs:
            del kwargs[param]
    
    # Merge additional parameters
    params.update(kwargs)
    
    try:
        response = await cerebras_client.chat.completions.create(**params)
        
        if hasattr(response, 'choices') and len(response.choices) > 0:
            return response.choices[0].message.content
        else:
            raise ValueError("Unexpected response format from Cerebras API")
            
    except Exception as e:
        raise Exception(f"Error calling Cerebras API: {str(e)}")
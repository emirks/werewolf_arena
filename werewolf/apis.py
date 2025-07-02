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


from openai import OpenAI
import os

from typing import Any
import google
from google import genai
from anthropic import AnthropicVertex

from dotenv import load_dotenv

load_dotenv(override=True)

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

# Initialize Google GenAI client
genai_client = genai.Client(api_key=os.environ.get("GOOGLE_API_KEY"))


def generate(model, **kwargs):
    if "gpt" in model:
        return generate_openai(model, **kwargs)
    elif "claude" in model:
        return generate_authropic(model, **kwargs)
    else:
        return generate_genai(model, **kwargs)


# openai
def generate_openai(
    model: str, prompt: str, json_mode: bool = True, temperature: float = 1.0, **kwargs
):
    response_format = {"type": "text"}
    if json_mode:
        response_format = {"type": "json_object"}
    response = client.chat.completions.create(
        messages=[{"role": "user", "content": prompt}],
        response_format=response_format,
        model=model,
        temperature=temperature,
    )

    txt = response.choices[0].message.content
    return txt


# anthropic
def generate_authropic(model: str, prompt: str, **kwargs):
    # For local development, run `gcloud auth application-default login` first to
    # create the application default credentials, which will be picked up
    # automatically here.
    _, project_id = google.auth.default()
    client = AnthropicVertex(region="us-east5", project_id=project_id)

    response = client.messages.create(
        model=model, messages=[{"role": "user", "content": prompt}], max_tokens=1024
    )

    return response.content[0].text


# google genai (replacing vertexai)
def generate_genai(
    model: str,
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
        response = genai_client.models.generate_content(
            model=model,
            contents=prompt,
            config=config
        )
        
        return response.text
        
    except Exception as e:
        # Fallback without JSON constraints if there's an error
        try:
            response = genai_client.models.generate_content(
                model=model,
                contents=prompt,
                config={"temperature": temperature}
            )
            return response.text
        except Exception as fallback_error:
            raise Exception(f"GenAI generation failed: {fallback_error}")


# Keep the old function name for backward compatibility
def generate_vertexai(
    model: str,
    prompt: str,
    temperature: float = 0.7,
    json_mode: bool = True,
    json_schema: dict[str, Any] | None = None,
    **kwargs,
) -> str:
    """Legacy function - redirects to generate_genai for backward compatibility."""
    return generate_genai(model, prompt, temperature, json_mode, json_schema, **kwargs)

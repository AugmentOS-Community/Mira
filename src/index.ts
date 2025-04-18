import path from 'path';
import {
  TpaSession,
  TpaServer,
  StreamType,
  LayoutType,
  ToolCall,
} from '@augmentos/sdk';
import { MiraAgent } from './agents';
import { wrapText } from './utils';
import { getAllToolsForUser } from './agents/tools/TpaTool';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80;
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.augmentos.miraai";
const AUGMENTOS_API_KEY = process.env.AUGMENTOS_API_KEY || 'test_key'; // In production, this would be securely stored

console.log(`Starting ${PACKAGE_NAME} server on port ${PORT}...`);
console.log(`Using API key: ${AUGMENTOS_API_KEY}`);

// Wake words that trigger Mira
const explicitWakeWords = [
  "hey mira", "he mira", "hey mara", "he mara", "hey mirror", "he mirror",
  "hey miara", "he miara", "hey mia", "he mia", "hey mural", "he mural",
  "hey amira", "hey myra", "he myra", "hay mira", "hai mira", "hey-mira",
  "he-mira", "heymira", "heymara", "hey mirah", "he mirah", "hey meera", "he meera",
  "Amira", "amira", "a mira", "a mirror"
];

/**
 * Manages the transcription state for active sessions
 */
class TranscriptionManager {
  private isProcessingQuery: boolean = false;
  private timeoutId?: NodeJS.Timeout;
  private session: TpaSession;
  private sessionId: string;
  private userId: string;
  private miraAgent: MiraAgent;
  private transcriptionStartTime: number = 0;

  constructor(session: TpaSession, sessionId: string, userId: string, miraAgent: MiraAgent) {
    this.session = session;
    this.sessionId = sessionId;
    this.userId = userId;
    this.miraAgent = miraAgent;
  }

  /**
   * Process incoming transcription data
   */
  handleTranscription(transcriptionData: any): void {
    // If a query is already being processed, ignore additional transcriptions
    if (this.isProcessingQuery) {
      console.log(`[Session ${this.sessionId}]: Query already in progress. Ignoring transcription.`);
      return;
    }

    const text = transcriptionData.text;
    // Clean the text: lowercase and remove punctuation for easier matching
    const cleanedText = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const hasWakeWord = explicitWakeWords.some(word => cleanedText.includes(word));

    if (!hasWakeWord) {
      console.log('No wake word detected');
      return;
    }

    console.log(`[Session ${this.sessionId}]: Wake word detected in text "${text}"`);

    // If this is our first detection, start the transcription timer
    if (this.transcriptionStartTime === 0) {
      this.transcriptionStartTime = Date.now();
    }

    // Send immediate display feedback
    this.session.layouts.showTextWall(
      "Listening...",
      { durationMs: 10000 }
    );

    let timerDuration: number;

    if (transcriptionData.isFinal) {
      // Check if the final transcript ends with a wake word
      if (this.endsWithWakeWord(cleanedText)) {
        // If it ends with just a wake word, wait longer for additional query text
        timerDuration = 3000;
      } else {
        // Final transcript with additional content should be processed soon
        timerDuration = 1500;
      }
    } else {
      // For non-final transcripts
      timerDuration = this.transcriptionStartTime === 0 ? 3000 : 1500;
    }

    // Clear any existing timeout
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    // Set a new timeout to process the query
    this.timeoutId = setTimeout(() => {
      this.processQuery(text);
    }, timerDuration);
  }

  /**
   * Process and respond to the user's query
   */
  private async processQuery(rawText: string): Promise<void> {
    // Prevent multiple queries from processing simultaneously
    if (this.isProcessingQuery) {
      return;
    }

    this.isProcessingQuery = true;

    try {
      // Remove wake word from query
      const query = this.removeWakeWord(rawText);
      console.log(`[Session ${this.sessionId}]: Processing query: "${query}"`);

      if (query.trim().length === 0) {
        this.session.layouts.showTextWall(
          wrapText("No query provided", 30),
          { durationMs: 5000 }
        );
        return;
      }

      // Show the query being processed
      this.session.layouts.showTextWall(
        wrapText("Processing query: " + query, 30),
        { durationMs: 8000 }
      );

      // Process the query with the Mira agent
      const inputData = { query };
      const agentResponse = await this.miraAgent.handleContext(inputData);

      if (!agentResponse) {
        console.log("No insight found");
        this.session.layouts.showTextWall(
          wrapText("Sorry, I couldn't find an answer to that.", 30),
          { durationMs: 5000 }
        );
      } else {
        console.log("Insight found:", agentResponse);
        this.session.layouts.showTextWall(
          wrapText(agentResponse, 30),
          { durationMs: 8000 }
        );
      }
    } catch (error) {
      console.error(`[Session ${this.sessionId}]: Error processing query:`, error);
      this.session.layouts.showTextWall(
        wrapText("Sorry, there was an error processing your request.", 30),
        { durationMs: 5000 }
      );
    } finally {
      // Reset the state for future queries
      this.transcriptionStartTime = 0;
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = undefined;
      }

      // Reset processing state after a delay
      setTimeout(() => {
        this.isProcessingQuery = false;
      }, 1000);
    }
  }

  /**
   * Remove the wake word from the input text
   */
  private removeWakeWord(text: string): string {
    // Escape each wake word for regex special characters
    const escapedWakeWords = explicitWakeWords.map(word =>
      word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    // Build patterns that allow for spaces, commas, or periods between the words
    const wakePatterns = escapedWakeWords.map(word =>
      word.split(' ').join('[\\s,\\.]*')
    );
    // Create a regex that removes everything from the start until (and including) a wake word
    const wakeRegex = new RegExp(`.*?(?:${wakePatterns.join('|')})[\\s,\\.]*`, 'i');
    return text.replace(wakeRegex, '').trim();
  }

  /**
   * Check if text ends with a wake word
   */
  private endsWithWakeWord(text: string): boolean {
    return explicitWakeWords.some(word => text.trim().endsWith(word));
  }

  /**
   * Clean up resources when the session ends
   */
  cleanup(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
  }
}

/**
 * Main Mira TPA server class
 */
class MiraServer extends TpaServer {
  private transcriptionManagers = new Map<string, TranscriptionManager>();
  private agentPerSession = new Map<string, MiraAgent>();

  /**
   * Handle new session connections
   */
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`Setting up Mira service for session ${sessionId}, user ${userId}`);
    const agent = new MiraAgent();
    // Start fetching tools asynchronously without blocking
    getAllToolsForUser(userId).then(tools => {
      // Append tools to agent when they're available
      if (tools.length > 0) {
        agent.agentTools.push(...tools);
        console.log(`Added ${tools.length} user tools to agent for user ${userId}`);
      }
    }).catch(error => {
      console.error(`Failed to load tools for user ${userId}:`, error);
    });
    this.agentPerSession.set(sessionId, agent);

    // Create transcription manager for this session
    const transcriptionManager = new TranscriptionManager(
      session, sessionId, userId, agent
    );
    this.transcriptionManagers.set(sessionId, transcriptionManager);

    // Welcome message
    session.layouts.showReferenceCard(
      "Mira AI",
      "Virtual assistant connected",
      { durationMs: 3000 }
    );

    // Handle transcription data
    session.events.onTranscription((transcriptionData) => {
      transcriptionManager.handleTranscription(transcriptionData);
    });

    session.events.onLocation((locationData) => {
      this.handleLocation(locationData, sessionId);
    });

    // Handle connection events
    session.events.onConnected((settings) => {
      console.log(`\n[User ${userId}] connected to augmentos-cloud\n`);
    });

    // Handle errors
    session.events.onError((error) => {
      console.error(`[User ${userId}] Error:`, error);
    });
  }

  private async handleLocation(locationData: any, sessionId: string): Promise<void> {
    try {
      const { latitude, longitude } = locationData;
      
      if (!latitude || !longitude) {
        console.log('Invalid location data received');
        return;
      }

      // Use OpenStreetMap Nominatim API for reverse geocoding
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`
      );
      
      if (!response.ok) {
        throw new Error('Failed to fetch location data');
      }

      const data = await response.json();
      
      // Extract relevant location information
      const address = data.address;
      const locationInfo = {
        city: address.city || address.town || address.village || 'Unknown city',
        district: address.suburb || address.neighbourhood || 'Unknown district',
        country: address.country || 'Unknown country'
      };

      // Update the MiraAgent with location context
      this.agentPerSession.get(sessionId)?.updateLocationContext(locationInfo);
      
      console.log(`User location: ${locationInfo.city}, ${locationInfo.district}, ${locationInfo.country}`);
    } catch (error) {
      console.error('Error processing location:', error);
      // Update MiraAgent with fallback location context
      this.agentPerSession.get(sessionId)?.updateLocationContext({
        city: 'Unknown',
        district: 'Unknown',
        country: 'Unknown'
      });
    }
  }

  // Handle session disconnection
  protected onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    console.log(`Stopping Mira service for session ${sessionId}, user ${userId}`);
    const manager = this.transcriptionManagers.get(sessionId);
    if (manager) {
      manager.cleanup();
      this.transcriptionManagers.delete(sessionId);
    }
    this.agentPerSession.delete(sessionId);
    return Promise.resolve();
  }
}

// Create and start the server
const server = new MiraServer({
  packageName: PACKAGE_NAME,
  apiKey: AUGMENTOS_API_KEY,
  port: PORT,
  webhookPath: '/webhook',
  publicDir: path.join(__dirname, './public')
});

server.start()
  .then(() => {
    console.log(`${PACKAGE_NAME} server running`);
  })
  .catch(error => {
    console.error('Failed to start server:', error);
  });
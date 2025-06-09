// MiraAgent.ts

import { Agent } from "./AgentInterface";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { SearchToolForAgents } from "./tools/SearchToolForAgents";
import { PromptTemplate } from "@langchain/core/prompts";
import { LLMProvider } from "../utils";
import { wrapText } from "../utils";
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { Tool } from "langchain/tools";
import { TpaCommandsTool } from "./tools/TpaCommandsTool";
import { TimerTool } from "./tools/TimerTool";

interface QuestionAnswer {
    insight: string;
}

const systemPromptBlueprint = `You are Mira, a helpful, witty, and concise AI assistant living in smart glasses. You have a friendly, playful personality and always answer in character as Mira. When asked about yourself or your abilities, respond in a way that reflects your role as the smart glasses assistant, referencing your skills and available tools. Express your status or mood in a light, playful manner. Always keep answers under 15 words, telegraph style, and never break character.

You are an intelligent assistant that is running on the smart glasses of a user. They sometimes directly talk to you by saying a wake word and then asking a question (User Query). Answer the User Query to the best of your ability. Try to infer the User Query intent even if they don't give enough info. The query may contain some extra unrelated speech not related to the query - ignore any noise to answer just the user's intended query. Make your answer concise, leave out filler words, make the answer high entropy, answer in 15 words or less (no newlines), but don't be overly brief (e.g. for weather, give temp. and rain). Use telegraph style writing.

Utilize available tools when necessary and adhere to the following guidelines:
1. Invoke the "Search_Engine" tool for confirming facts or retrieving extra details. Use the Search_Engine tool automatically to search the web for information about the user's query whenever you don't have enough information to answer.
2. Use any other tools at your disposal as appropriate.
3. You should think out loud before you answer. Come up with a plan for how to determine the answer accurately and then execute the plan.
4. Keep your final answer brief (fewer than 15 words).
5. When you have enough information to answer, output your final answer on a new line prefixed by "Final Answer:" followed immediately by a concise answer:
   "Final Answer: <concise answer>"
6. If the query is empty, nonsensical, or useless, return Final Answer: "No query provided."
7. For context, today's date is ${new Date().toUTCString().split(' ').slice(0,4).join(' ')}.
8. If the user's query is location-specific (e.g., weather, news, events, or anything that depends on place), always use the user's current location context to provide the most relevant answer.

{location_context}
{notifications_context}
Tools:
{tool_names}

Remember to always include the Final Answer: marker in your final response.`;

export class MiraAgent implements Agent {
  public agentId = "mira_agent";
  public agentName = "MiraAgent";
  public agentDescription =
    "Answers user queries from smart glasses using conversation context and history.";
  public agentPrompt = systemPromptBlueprint;
  public agentTools:Tool[];

  public messages: BaseMessage[] = [];

  private locationContext: {
    city: string;
    state: string;
    country: string;
  } = {
    city: 'Unknown',
    state: 'Unknown',
    country: 'Unknown'
  };

  constructor(cloudUrl: string, userId: string) {
    this.agentTools = [
      new SearchToolForAgents(),
      new TpaCommandsTool(cloudUrl, userId),
      new TimerTool(),
    ];
  }

  /**
   * Updates the agent's location context
   */
  public updateLocationContext(locationInfo: {
    city: string;
    state: string;
    country: string;
  }): void {
    this.locationContext = locationInfo;
  }

  /**
   * Parses the final LLM output.
   * If the output contains a "Final Answer:" marker, the text after that marker is parsed as JSON.
   * Expects a JSON object with an "insight" key.
   */
  private parseOutput(text: string): QuestionAnswer {

    console.log("MiraAgent Text:", text);
    const finalMarker = "Final Answer:";
    if (text.includes(finalMarker)) {
      text = text.split(finalMarker)[1].trim();
      return { insight: text };
    }
    try {
      const parsed = JSON.parse(text);
      // If the object has an "insight" key, return it.
      if (typeof parsed.insight === "string") {
        return { insight: parsed.insight };
      }
      // If the output is a tool call (e.g. has searchKeyword) or missing insight, return a null insight.
      if (parsed.searchKeyword) {
        return { insight: "null" };
      }
    } catch (e) {
      // Fallback attempt to extract an "insight" value from a string
      const match = text.match(/"insight"\s*:\s*"([^"]+)"/);
      if (match) {
        return { insight: match[1] };
      }
    }
    return { insight: "Error processing query." };
  }

  public async handleContext(userContext: Record<string, any>): Promise<any> {
    try {
      // Extract required fields from the userContext.
      const transcriptHistory = userContext.transcript_history || "";
      const insightHistory = userContext.insight_history || "";
      const query = userContext.query || "";

      let turns = 0;

      // If query is empty, return default response.
      if (!query.trim()) {
        return { result: "No query provided." };
      }

      console.log("Query:", query);
      console.log("Location Context:", this.locationContext);
      // Only add location context if we have a valid city
      const locationInfo = this.locationContext.city !== 'Unknown'
      ? `For context the User is currently in ${this.locationContext.city}, ${this.locationContext.state}, ${this.locationContext.country}.\n\n`
      : '';

      // Add notifications context if present
      let notificationsContext = '';
      if (userContext.notifications && Array.isArray(userContext.notifications) && userContext.notifications.length > 0) {
        // Format as a bullet list of summaries, or fallback to title/text
        const notifs = userContext.notifications.map((n: any, idx: number) => {
          if (n.summary) return `- ${n.summary}`;
          if (n.title && n.text) return `- ${n.title}: ${n.text}`;
          if (n.title) return `- ${n.title}`;
          if (n.text) return `- ${n.text}`;
          return `- Notification ${idx+1}`;
        }).join('\n');
        notificationsContext = `Recent notifications:\n${notifs}\n\n`;
      }

      const llm = LLMProvider.getLLM().bindTools(this.agentTools);
      const toolNames = this.agentTools.map((tool) => tool.name+": "+tool.description || "");

      // Replace the {tool_names} placeholder with actual tool names and descriptions
      const systemPrompt = systemPromptBlueprint
        .replace("{tool_names}", toolNames.join("\n"))
        .replace("{location_context}", locationInfo)
        .replace("{notifications_context}", notificationsContext);

      this.messages.push(new SystemMessage(systemPrompt));
      this.messages.push(new HumanMessage(query));

      while (turns < 5) {
        // Invoke the chain with the query
        const result: AIMessage = await llm.invoke(this.messages);
        this.messages.push(result);

        const output: string = result.content.toString();

        if (result.tool_calls) {
          for (const toolCall of result.tool_calls) {
            const selectedTool = this.agentTools.find(tool => tool.name === toolCall.name);
            if (selectedTool) {
              const toolMessage: ToolMessage = await selectedTool.invoke(toolCall);
              if (toolMessage.content == "" || toolMessage.content == null) {
                toolMessage.content = "Tool executed successfully but did not return any information.";
              }
              if (toolMessage.id == null) {
                toolMessage.id = toolCall.id;
              }
              // Always push the tool message
              this.messages.push(toolMessage);
              // Check for timer event
              if (typeof toolMessage.content === 'string') {
                try {
                  const parsed = JSON.parse(toolMessage.content);
                  if (parsed && parsed.event === 'timer_set' && parsed.duration) {
                    return toolMessage.content; // Return timer event JSON directly
                  }
                } catch (e) { /* not JSON, ignore */ }
              }
            } else {
              console.log("Tried to call a tool that doesn't exist:", toolCall.name);
              // Add a placeholder tool call message indicating the tool is unavailable
              const unavailableToolMessage = new ToolMessage({
                content: `Tool ${toolCall.name} unavailable`,
                tool_call_id: toolCall.id || `unknown_${Date.now()}`,
                status: "error"
              });
              this.messages.push(unavailableToolMessage);
            }
          }
        }

        const finalMarker = "Final Answer:";
        if (output.includes(finalMarker)) {
          console.log("Final Answer:", output);
          const parsedResult = this.parseOutput(output);
          return parsedResult.insight;
        }
        console.log(`Result for turn ${turns}: ${output}`);

        turns++;
      }
    } catch (err) {
      console.error("[MiraAgent] Error:", err);
      const errString = String(err);
      return errString.match(/LLM output:\s*(.*)$/)?.[1] || "Error processing query.";
    }
  }
}

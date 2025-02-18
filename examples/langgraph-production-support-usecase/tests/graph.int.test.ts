import { describe, it, expect } from "@jest/globals";
import { IncidentGenerator } from "../src/agent/incidents.js";
import { Message } from "../src/agent/utils.js";
import { graph } from "../src/agent/graph.js";
import { isAIMessage } from "@langchain/core/messages";

describe("Graph", () => {
  it("should process input through the graph", async () => {
    const incidentGenerator = new IncidentGenerator();
    const result = await graph.invoke({
      messages: [Message.human(incidentGenerator.randomIncident())],
    });

    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);

    const lastMessage = Message.lastMessage(result.messages);
    expect(isAIMessage(lastMessage)).toBeTruthy();
    expect(lastMessage.content.toString()).toContain(
      "Here is a summary of the operation:",
    );
  }, 120000); // Increased timeout to 2 minutes
});

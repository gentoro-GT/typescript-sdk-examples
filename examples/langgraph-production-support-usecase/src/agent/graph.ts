import { END, START, StateGraph } from "@langchain/langgraph";
import { StateAnnotation } from "./state.js";
import {
  isToolMessage,
  ToolCall,
  ToolMessage,
} from "@langchain/core/messages/tool";
import { ToolDefinition } from "@langchain/core/language_models/base";
import {
  AIMessage,
  isAIMessage,
  BaseMessage,
  AIMessageChunk,
  isSystemMessage,
  isHumanMessage,
  isAIMessageChunk,
  BaseMessageChunk,
  isBaseMessageChunk,
} from "@langchain/core/messages";
import * as dotenv from "dotenv";
import {
  ExecError,
  ExecOutput,
  ExecResulType,
  ExecResult,
  Gentoro,
  Providers,
  SdkConfig,
  FunctionDef,
  FunctionParameterCollection,
  FunctionParameter,
  ToolCall as GentoroToolCall,
  ToolDef,
} from "@gentoro/sdk";
import { ChatOpenAI } from "@langchain/openai";
import { TemplateGenerator } from "./template.js";
import { Message } from "./utils.js";
dotenv.config();

const { env } = process;
const config: SdkConfig = {
  apiKey: env.GENTORO_API_KEY,
  baseUrl: "http://localhost:8082",
  authModBaseUrl: "http://localhost:3000",
  provider: Providers.Gentoro,
};
const templateGenerator = new TemplateGenerator();
const gentoro = new Gentoro(config);

/**
 * Load all mapped tools from Gentoro.
 * This implies that Administrator has already gone to Gentoro Studio and set up the Bridge and its tools.
 */
const gentoroTools: ToolDef[] = (await gentoro.getTools(
  env.GENTORO_BRIDGE_UID as string,
)) as ToolDef[];
const tools: ToolDefinition[] = gentoroTools.map((tool: ToolDef) => {
  const functionDef: FunctionDef = tool.definition;
  const parameters: FunctionParameterCollection = functionDef.parameters;
  const properties: Record<string, object> = {};
  parameters.properties.map((p: FunctionParameter) => {
    properties[p.name] = {
      type: "string",
      description: p.description,
    } as object;
  });

  return {
    type: tool.type,
    function: {
      name: functionDef.name,
      description: functionDef.description,
      parameters: {
        type: "object",
        properties: properties,
        required: functionDef.parameters.required,
      },
    },
  } as ToolDefinition;
}) as ToolDefinition[];

/**
 * Creates a tool definition that aligns with the prompt template,
 * Whenever called it will place a signal to end the graph execution, so routing function can take the proper action.
 * Should be called in two scenarios:
 *  - When the agent has finished its execution and is ready to report the results.
 *  - When an unrecoverable error has occurred and the agent needs to report it.
 *
 *  Both scenarios will result on the graph execution to end.
 */
const endGraphToolDef: ToolDefinition = {
  type: "function",
  function: {
    name: "end_graph",
    description: "Use this function to report the end of the graph execution",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Pass here the summary of the execution and actions taken, if any. In case of errors or issues, please provide a detailed description.",
        },
      },
      required: ["summary"],
    },
  },
};
tools.push(endGraphToolDef);

/**
 * Node responsible for pulling the most up to date runbook from Gentoro.
 * This function is triggered directly from the graph's start node.
 * LLM has no visibility of it.
 * @param state The current state of the graph. Used to retrieve the incident report, which is the first message in the state.
 */
const loadRunbook = async (
  state: typeof StateAnnotation.State,
): Promise<typeof StateAnnotation.Update> => {
  const result: ExecResult = (await gentoro.runToolNatively(
    env.GENTORO_BRIDGE_UID as string,
    "retrieve_runbook_content",
    {},
  )) as ExecResult;
  if (result.type === ExecResulType.Error) {
    const execError: ExecError = result.data as ExecError;
    return {
      endGraphSignal: true,
      messages: [
        Message.system(
          templateGenerator.formattedTemplate("report_unrecoverable_error", {
            error_message:
              "There was an error attempting to load the runbook." +
              execError.message,
          }),
        ),
      ],
    };
  } else {
    const data: ExecOutput = result.data as ExecOutput;
    const runBook: string = JSON.parse(data.content).runbook as string;
    return {
      messages: [
        Message.system(
          templateGenerator.formattedTemplate("leading_message_with_context", {
            run_book_content: runBook,
            incident_report: state.messages[0].content as string,
          }),
        ),
      ],
    };
  }
};

/**
 * Node responsible for tool execution.
 * Usually called as a result of model directives that will result in one or more tools to be called.
 * Integrates with Gentoro SDK and delegates the execution.
 *
 * Should update state with the results of the tool execution, and possible the tool execution signals the end of the graph, in case the tool eng_graph is listed to be called.
 * @param state The current state of the graph. Used to retrieve the last message, which should be an AI message or chunk.
 */
const callTools = async (
  state: typeof StateAnnotation.State,
): Promise<typeof StateAnnotation.Update> => {
  let toolCalls: ToolCall[] = state.toolCalls;
  let endGraphSignal: boolean | null = null;
  let endGraphSummary: string | null = null;
  if (toolCalls.filter((tc) => tc.name === "end_graph").length > 0) {
    toolCalls = toolCalls.filter((tc) => tc.name !== "end_graph");
    endGraphSignal = true;
    endGraphSummary = toolCalls.find((tc) => tc.name === "end_graph")?.args
      .summary;
  }

  const _tools: GentoroToolCall[] = toolCalls.map(
    (toolCall) =>
      ({
        id: toolCall.id,
        type: toolCall.type,
        details: {
          name: toolCall.name,
          arguments:
            toolCall.args != null ? JSON.stringify(toolCall.args) : "{}",
        },
      }) as GentoroToolCall,
  );

  const result: ExecResult[] = (await gentoro.runTools(
    env.GENTORO_BRIDGE_UID as string,
    null,
    _tools,
  )) as ExecResult[];

  const _toolMessages: ToolMessage[] = [];
  result
    .filter((r) => r.type === ExecResulType.ExecOutput)
    .forEach((r) => {
      let toolMessage: ToolMessage | null = null;
      if (r.type === ExecResulType.ExecOutput) {
        const execOutput = r.data as ExecOutput;
        let content = String(execOutput.content);
        let status: "success" | "error" = "success";
        try {
          const jsonContent = JSON.parse(execOutput.content);
          if (jsonContent.error) {
            content = jsonContent.error;
            status = "error";
          }
        } catch (e) {
          console.log("Error parsing tool output", e);
        }
        toolMessage = new ToolMessage({
          status: status,
          content: content as string,
          tool_call_id: r.toolCallId,
        });
      } else if (r.type === ExecResulType.Error) {
        const execError: ExecError = r.data as ExecError;
        toolMessage = new ToolMessage({
          status: "error",
          content: execError.message,
          tool_call_id: r.toolCallId,
        });
      }
      if (toolMessage != null) {
        _toolMessages.push(toolMessage as ToolMessage);
      }
    });

  const updatedState: Record<any, any> = {
    messages: [...state.messages, ...(_toolMessages as BaseMessage[])],
  };

  if (endGraphSignal === true) {
    updatedState.endGraphSignal = true;
    updatedState.messages = [
      ...state.messages,
      Message.system(endGraphSummary as string),
    ];
  }
  return updatedState;
};

/**
 * Node responsible for interaction between Graph and Model.
 * It will send all messages present in the stage, and the model will return a new message, which will be added to the state.
 * This AI message will be analyzed to determine if it requires any tool to be called.
 *
 * @param state The current state of the graph.
 */
const callModel = async (
  state: typeof StateAnnotation.State,
): Promise<typeof StateAnnotation.Update> => {
  const llm = new ChatOpenAI({
    apiKey: env.OPENAI_API_KEY,
    model: "gpt-4o",
  }).bindTools(tools);
  const message: AIMessageChunk = await llm.invoke(state.messages);

  // check if LLM asked one or more tools to be executed.
  const toolCalls: ToolCall[] = [];
  if (
    isAIMessage(message) ||
    (isBaseMessageChunk(message) &&
      isAIMessageChunk(message as BaseMessageChunk))
  ) {
    if (isAIMessage(message)) {
      toolCalls.push(...((message as AIMessage).tool_calls || []));
    } else {
      toolCalls.push(...((message as AIMessageChunk).tool_calls || []));
    }
  }

  return {
    messages: [...state.messages, message],
    toolCalls: toolCalls,
  };
};

const StringUtils = {
  isBlank: (str: string | null | undefined): boolean => {
    return !str || /^\s*$/.test(str);
  },
  stringify: (str: string | undefined) => {
    return (str || "").replace(/[\n\r]/g, "\\n").trim();
  },
};

const reAct = async (
  state: typeof StateAnnotation.State,
): Promise<typeof StateAnnotation.Update> => {
  const reActMessages: BaseMessage[] = [];
  const updatedState: Record<any, any> = {
    messages: reActMessages,
    toolCalls: state.toolCalls,
    endGraphSignal: state.endGraphSignal,
  };

  for (let i = 0; i < state.messages.length; i++) {
    const m = state.messages[i];
    if (isAIMessage(m)) {
      const aiMessage = m as AIMessage;
      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        let aiMessageContentBuilder = "";
        if (!StringUtils.isBlank(aiMessage.content as string | null)) {
          aiMessageContentBuilder += aiMessage.content + "\n\n";
        }

        if (
          state.toolCalls.length === 1 &&
          state.toolCalls[0].name === "end_graph"
        ) {
          updatedState.endGraphSignal = true;
          aiMessageContentBuilder +=
            "\nHere is a summary of the operation:\n\n" +
            state.toolCalls[0].args.summary;
        } else {
          aiMessageContentBuilder +=
            "Lets execute the following tool(s) to gather more information:\n" +
            "| tool_call_id | tool_name | arguments |\n" +
            "| ------------ | --------- | ------------ |\n" +
            aiMessage.tool_calls
              .map(
                (tc) =>
                  "|" +
                  tc.id +
                  "|" +
                  tc.name +
                  "|" +
                  JSON.stringify(tc.args) +
                  "|",
              )
              .join("\n");
        }
        reActMessages.push(Message.AI(aiMessageContentBuilder));
        continue;
      }
    }

    if (isToolMessage(m)) {
      const toolMessage = m as ToolMessage;
      const toolCall = state.toolCalls?.find(
        (tc) => tc.id === toolMessage.tool_call_id,
      ) as ToolCall;
      const toolDefinition: ToolDefinition = tools.find(
        (toolDef) => toolDef.function.name === toolCall.name,
      ) as ToolDefinition;

      const messageContentBuilder: string =
        "Sure, here is the outcome of your assignment.\n" +
        "| tool_call_id | tool_name | description | status | result |\n" +
        "| ------------ | --------- | ----------- | ------ | ------ |\n" +
        "| " +
        toolCall.id +
        " | " +
        StringUtils.stringify(toolDefinition.function.name) +
        " | " +
        StringUtils.stringify(toolDefinition.function.description) +
        " | " +
        toolMessage.status +
        " | " +
        toolMessage.content +
        " |\n";

      reActMessages.push(Message.human(messageContentBuilder));
      updatedState.toolCalls = [];

      continue;
    }

    reActMessages.push(m);
  }

  console.log("reActState", updatedState);
  return updatedState;
};

/**
 * Routing function: Determines whether to continue research or end the builder.
 * This function decides if the gathered information is satisfactory or if more research is needed.
 *
 * @param state - The current state of the research builder
 * @returns Either "callModel" to continue research or END to finish the builder
 */
export const route = (
  state: typeof StateAnnotation.State,
): "__end__" | "callModel" | "callTools" => {
  if (state.endGraphSignal === true) {
    // something went wrong, second system message means that an error was reported.
    return END;
  }

  const lastMessage = Message.lastMessage(state.messages);
  if (state.toolCalls && state.toolCalls.length > 0) {
    //AI needs one or more tools to be called.
    return "callTools";
  }

  if (isHumanMessage(lastMessage) || isSystemMessage(lastMessage)) {
    return "callModel";
  }

  return END;
};

// Finally, create the graph itself.
const builder = new StateGraph(StateAnnotation)
  .addNode("callModel", callModel)
  .addNode("callTools", callTools)
  .addNode("loadRunBook", loadRunbook)
  .addNode("reAct", reAct)

  .addEdge(START, "loadRunBook")
  .addEdge("loadRunBook", "reAct")
  .addEdge("callTools", "reAct")
  .addEdge("callModel", "reAct")
  .addConditionalEdges("reAct", route, ["callModel", "callTools", END]);

export const graph = builder.compile();
graph.name = "Production Support Agent";

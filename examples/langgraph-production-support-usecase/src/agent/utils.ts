import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";

export const Message = {
  lastMessage: (messages: BaseMessage[]): BaseMessage => {
    return messages[messages.length - 1];
  },
  human: (content: string): HumanMessage => {
    return new HumanMessage({ content: content });
  },
  system: (content: string): SystemMessage => {
    return new SystemMessage({ content: content });
  },
  AI: (content: string): AIMessage => {
    return new AIMessage({ content: content });
  },
};

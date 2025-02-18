import * as fs from "fs";
import { parse } from "yaml";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface Template {
  name: string;
  content: string;
}

export interface PromptTemplates {
  templates: Template[];
}

export class TemplateGenerator {
  private _data: PromptTemplates | null = null;

  constructor() {
    const fileContents = fs.readFileSync(
      path.resolve(__dirname, "templates.yaml"),
      "utf8",
    );
    this._data = parse(fileContents) as PromptTemplates;
  }

  public template(name: string): string {
    if (this._data == null) {
      throw new Error("Template file not initialized");
    }
    const template = this._data.templates.find((t) => t.name === name);
    if (template == null) {
      throw new Error(`Template ${name} not found`);
    }
    return template.content;
  }

  public formattedTemplate(
    name: string,
    values: Record<string, string>,
  ): string {
    let content = this.template(name);
    Object.keys(values).forEach((key) => {
      content = content.replace(`{{${key}}}`, values[key]);
    });
    return content;
  }
}

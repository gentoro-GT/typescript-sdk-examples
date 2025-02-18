import * as fs from "fs";
import { parse } from "yaml";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface Incident {
  title: string;
  report: string;
}

export interface Incidents {
  incidents: Incident[];
}

export class IncidentGenerator {
  private _data: Incidents | null = null;

  constructor() {
    const fileContents = fs.readFileSync(
      path.resolve(__dirname, "incidents.yaml"),
      "utf8",
    );
    this._data = parse(fileContents) as Incidents;
  }

  public incident(title: string): string {
    if (this._data == null) {
      throw new Error("Incident file not initialized");
    }
    const incident = this._data.incidents.find((t) => t.title === title);
    if (incident == null) {
      throw new Error(`Incident ${title} not found`);
    }
    return incident.report;
  }

  public randomIncident(): string {
    if (this._data == null) {
      throw new Error("Incident file not initialized");
    }
    const incident =
      this._data.incidents[
        Math.floor(Math.random() * this._data.incidents.length)
      ];
    return incident.report;
  }
}

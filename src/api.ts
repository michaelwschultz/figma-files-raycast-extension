import { LocalStorage, Toast, environment, getPreferenceValues, showToast } from "@raycast/api";
import { getAccessToken } from "@raycast/utils";
import type { FileDetail, ProjectFiles, TeamFiles, TeamProjects } from "./types";

interface RequestError extends Error {
  response?: Response;
}

// Utility function for retry delays
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request<T>(path: string, opts?: RequestInit, { maxRetries = 2 } = {}) {
  const { PERSONAL_ACCESS_TOKEN } = getPreferenceValues();
  const { token, type } = getAccessToken();

  let attempts = 0;

  while (true) {
    const response = await fetch(`https://api.figma.com/v1${path}`, {
      headers: {
        ...opts?.headers,
        "Content-Type": "application/json",
        ...(type === "oauth" ? { Authorization: `Bearer ${token}` } : { "X-Figma-Token": PERSONAL_ACCESS_TOKEN }),
      },
      ...opts,
    });

    if (response.ok) {
      return response.json() as Promise<T>;
    }

    // Handle rate limiting (429 errors)
    if (response.status === 429) {
      if (attempts++ >= maxRetries) {
        const error: RequestError = new Error(`Rate limit exceeded after ${attempts} attempts. Please try again later.`);
        error.response = response;
        return Promise.reject(error);
      }

      // Use retry-after header if available, otherwise exponential backoff
      const retryAfterSec = Number(response.headers.get("retry-after")) || Math.min(2 ** attempts, 60);
      console.log(`Rate limited, retrying after ${retryAfterSec} seconds... (attempt ${attempts}/${maxRetries})`);

      await sleep(retryAfterSec * 1000);
      continue;
    }

    // Handle authentication errors (403 - token expired)
    if (response.status === 403) {
      const error: RequestError = new Error(
        `Auth failed: Your Figma access token has expired.`
      );
      error.response = response;
      return Promise.reject(error);
    }

    // Handle other HTTP errors
    const error: RequestError = new Error(`Request failed: ${response.status}: ${response.statusText}`);
    error.response = response;
    return Promise.reject(error);
  }
}

async function fetchTeamProjects(): Promise<TeamProjects[]> {
  const { TEAM_ID } = getPreferenceValues();
  const teamID: string[] = TEAM_ID.split(",").map((team: string) => team.toString().trim());

  try {
    return Promise.all(
      teamID.map((team) =>
        request<TeamProjects>(`/teams/${team}/projects`, {
          method: "GET",
        }),
      ),
    );
  } catch (error) {
    console.error(error);
    if (environment.launchType !== "background") {
      showToast(Toast.Style.Failure, "Could not load team projects");
    }
    return Promise.resolve([]);
  }
}

async function fetchFiles(): Promise<ProjectFiles[][]> {
  try {
    const teamProjects = await fetchTeamProjects();
    const teamNames = teamProjects.map((team) => team.name).join(",");
    await LocalStorage.setItem("teamNames", teamNames);

    const projectFiles = await Promise.all(
      teamProjects.map(async (team) => {
        const projects = await Promise.all(
          (team.projects || []).map(async (project) => {
            const result = await request<ProjectFiles>(`/projects/${project.id}/files?branch_data=true`, {
              method: "GET",
            });
            return { name: project.name, files: result.files ?? [] };
          }),
        );
        return projects;
      }),
    );

    return projectFiles;
  } catch (error) {
    console.error(error);
    if (environment.launchType !== "background") {
      showToast(Toast.Style.Failure, "Could not load files");
    }
    return [];
  }
}

export async function resolveAllFiles(): Promise<TeamFiles[]> {
  const teamFiles = await fetchFiles();
  const teams = ((await LocalStorage.getItem<string>("teamNames")) ?? "").split(",");
  const fi = teamFiles.map((projectFiles, index) => {
    return { name: teams[index], files: projectFiles } as TeamFiles;
  });
  return fi;
}

export async function fetchPages(fileKey: string) {
  try {
    const result = await request<FileDetail>(`/files/${fileKey}?depth=1`, {
      method: "GET",
    });
    return result.document.children;
  } catch (error) {
    console.error(error);
    if (environment.launchType !== "background") {
      showToast(Toast.Style.Failure, "Could not load pages (Figma Slides not supported)");
    }
    return Promise.resolve([]);
  }
}

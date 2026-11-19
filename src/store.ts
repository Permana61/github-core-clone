// In-memory store shared by REST, GraphQL, MCP and git.
// All timestamps come from MAKEFUN_TRIAL_NOW (never Date.now() / Math.random()).
// All ids are deterministic counters starting at 1.

export interface User {
  login: string;
  id: number;
  node_id: string;
  type: 'User';
  name: string;
  email: string;
}

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface Label {
  id: number;
  node_id: string;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  node_id: string;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  created_at: string;
  updated_at: string;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}

export interface Pull {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: User;
  created_at: string;
  updated_at: string;
  files: PullFile[];
}

export interface Repo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: User;
  private: boolean;
  description: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  has_issues: boolean;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

const FALLBACK_NOW = '2026-01-01T00:00:00.000Z';

// The twelve users of the scenario (RECON §1). Viewer is adaiversen, id 1000.
const SEED_USERS: Array<[string, number, string]> = [
  ['adaiversen', 1000, 'ada iversen'],
  ['quinnkeller', 1001, 'quinn keller'],
  ['olgabauer', 1002, 'olga bauer'],
  ['dmitriquist', 1003, 'dmitri quist'],
  ['adanovak', 1004, 'ada novak'],
  ['zanerossi', 1005, 'zane rossi'],
  ['pavelcosta', 1006, 'pavel costa'],
  ['wrenkeller', 1007, 'wren keller'],
  ['coraquist', 1008, 'cora quist'],
  ['elenaulrich', 1009, 'elena ulrich'],
  ['tesssato', 1010, 'tess sato'],
  ['svenrossi', 1011, 'sven rossi'],
];

export class Store {
  users: Map<string, User> = new Map();
  repos: Map<string, Repo> = new Map();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  nextLabelId = 1;
  viewer: User;
  now: string;

  constructor() {
    this.now = process.env.MAKEFUN_TRIAL_NOW ?? FALLBACK_NOW;
    for (const [login, id, name] of SEED_USERS) {
      const user: User = {
        login,
        id,
        node_id: this.globalId('User', String(id)),
        type: 'User',
        name,
        email: `${login}@example.invalid`,
      };
      this.users.set(login, user);
    }
    this.viewer = this.users.get('adaiversen') as User;
  }

  /** Opaque, stable, round-trippable global id: base64url(`${kind}:${key}`). */
  globalId(kind: string, key: string): string {
    return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
  }

  parseGlobalId(id: string): { kind: string; key: string } | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(id, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    const kind = decoded.slice(0, colon);
    const key = decoded.slice(colon + 1);
    if (key.length === 0) return null;
    // Round-trip check: the id must re-encode to itself, so raw numbers etc. are rejected.
    if (this.globalId(kind, key) !== id) return null;
    return { kind, key };
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(ownerLogin: string, name: string, opts?: { private?: boolean; description?: string }): Repo {
    let owner = this.users.get(ownerLogin);
    if (owner === undefined) {
      const id = 1000 + this.users.size;
      owner = {
        login: ownerLogin,
        id,
        node_id: this.globalId('User', String(id)),
        type: 'User',
        name: ownerLogin,
        email: `${ownerLogin}@example.invalid`,
      };
      this.users.set(ownerLogin, owner);
    }
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      node_id: this.globalId('Repository', String(id)),
      name,
      full_name: `${ownerLogin}/${name}`,
      owner,
      private: opts?.private ?? false,
      description: opts?.description ?? '',
      default_branch: 'main',
      created_at: this.now,
      updated_at: this.now,
      pushed_at: this.now,
      has_issues: true,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(repo.full_name, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(ownerLogin: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.login === ownerLogin) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

export function createStore(): Store {
  return new Store();
}

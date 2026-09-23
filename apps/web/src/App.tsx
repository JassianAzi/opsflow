import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  OrganizationMember,
  OrganizationSummary,
  PublicUser,
} from '@opsflow/shared';
import { api } from './api';
import { WorkflowWorkspace } from './WorkflowWorkspace';
import { confirmDiscardChanges } from './workflow-editor';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [selected, setSelected] = useState<OrganizationSummary | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [workflowDraft, setWorkflowDraft] = useState<{
    dirty: boolean;
    name: string;
  }>({ dirty: false, name: '' });
  const handleWorkflowDirtyChange = useCallback(
    (dirty: boolean, name = '') => setWorkflowDraft({ dirty, name }),
    [],
  );

  function allowWorkflowDiscard(action: string): boolean {
    return confirmDiscardChanges(
      workflowDraft.dirty,
      workflowDraft.name || 'the open workflow',
      action,
      (prompt) => window.confirm(prompt),
    );
  }

  useEffect(() => {
    void api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    void api
      .organizations()
      .then(({ organizations }) => setOrganizations(organizations))
      .catch((error: unknown) => setMessage(errorMessage(error)));
  }, [user]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      if (mode === 'register') {
        await api.register(email, password, displayName);
        setMode('login');
        setMessage('Account created. Sign in to continue.');
      } else {
        const result = await api.login(email, password);
        setUser(result.user);
      }
      setPassword('');
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!allowWorkflowDiscard('Sign out?')) return;
    setBusy(true);
    setMessage('');
    try {
      await api.logout();
      setUser(null);
      setOrganizations([]);
      setSelected(null);
      setMembers([]);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function openOrganization(id: string, discardApproved = false) {
    if (
      !discardApproved &&
      selected?.id !== id &&
      !allowWorkflowDiscard('Switch organizations?')
    )
      return;
    setMessage('');
    try {
      const [{ organization }, { members }] = await Promise.all([
        api.organization(id),
        api.members(id),
      ]);
      setSelected(organization);
      setMembers(members);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allowWorkflowDiscard('Create and open another organization?')) return;
    setBusy(true);
    setMessage('');
    try {
      const { organization } = await api.createOrganization(organizationName);
      setOrganizations((current) => [...current, organization]);
      setOrganizationName('');
      await openOrganization(organization.id, true);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-10 text-slate-50">
      <div className="mx-auto max-w-4xl">
        <header className="mb-12 flex items-center justify-between border-b border-slate-800 pb-6">
          <div>
            <p className="text-sm font-semibold tracking-[0.2em] text-cyan-400 uppercase">
              OpsFlow
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">
              Your workspace
            </h1>
          </div>
          {user && (
            <button
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800"
              onClick={() => void logout()}
              disabled={busy}
            >
              Sign out
            </button>
          )}
        </header>

        {message && (
          <p
            role="status"
            className="mb-6 rounded-lg border border-cyan-800 bg-cyan-950/40 p-3 text-sm text-cyan-100"
          >
            {message}
          </p>
        )}
        {checking ? (
          <p className="text-slate-400">Checking your session…</p>
        ) : user ? (
          <div className="grid gap-8 md:grid-cols-[1fr_1.2fr]">
            <section>
              <p className="mb-6 text-sm text-slate-400">
                Signed in as {user.displayName}
              </p>
              <h2 className="text-xl font-semibold">Organizations</h2>
              <p className="mt-2 text-sm text-slate-400">
                Choose an organization or create one to begin.
              </p>
              <div className="mt-5 space-y-2">
                {organizations.map((organization) => (
                  <button
                    key={organization.id}
                    onClick={() => void openOrganization(organization.id)}
                    className={`w-full rounded-lg border p-4 text-left hover:bg-slate-800 ${selected?.id === organization.id ? 'border-cyan-500 bg-slate-900' : 'border-slate-800 bg-slate-900/50'}`}
                  >
                    <span className="block font-medium">
                      {organization.name}
                    </span>
                    <span className="mt-1 block text-xs text-slate-400">
                      {organization.role}
                    </span>
                  </button>
                ))}
                {organizations.length === 0 && (
                  <p className="rounded-lg border border-dashed border-slate-700 p-5 text-sm text-slate-400">
                    No organizations yet.
                  </p>
                )}
              </div>
              <form
                className="mt-8 space-y-3"
                onSubmit={(event) => void createOrganization(event)}
              >
                <label
                  className="block text-sm font-medium"
                  htmlFor="organization-name"
                >
                  New organization
                </label>
                <input
                  id="organization-name"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 outline-none focus:border-cyan-500"
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                  required
                  maxLength={120}
                  placeholder="Organization name"
                />
                <button
                  disabled={busy}
                  className="rounded-lg bg-cyan-500 px-4 py-2 font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
                >
                  Create organization
                </button>
              </form>
            </section>
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
              {selected ? (
                <>
                  <p className="text-xs font-semibold tracking-widest text-cyan-400 uppercase">
                    Selected organization
                  </p>
                  <h2 className="mt-3 text-2xl font-semibold">
                    {selected.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">{selected.slug}</p>
                  <h3 className="mt-8 border-t border-slate-800 pt-6 font-semibold">
                    Members
                  </h3>
                  <ul className="mt-4 space-y-3">
                    {members.map((member) => (
                      <li
                        key={member.id}
                        className="flex items-center justify-between gap-4 text-sm"
                      >
                        <span>
                          {member.displayName}
                          <span className="block text-slate-400">
                            {member.email}
                          </span>
                        </span>
                        <span className="text-slate-400">{member.role}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-sm text-slate-400">
                  Select an organization to view its members.
                </p>
              )}
            </section>
            {selected && (
              <div className="md:col-span-2">
                <WorkflowWorkspace
                  key={selected.id}
                  organizationId={selected.id}
                  onDirtyChange={handleWorkflowDirtyChange}
                />
              </div>
            )}
          </div>
        ) : (
          <section className="mx-auto max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8">
            <h2 className="text-2xl font-semibold">
              {mode === 'login' ? 'Sign in' : 'Create an account'}
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              {mode === 'login'
                ? 'Access your organizations.'
                : 'Start with a secure local account.'}
            </p>
            <form
              className="mt-8 space-y-4"
              onSubmit={(event) => void submitAuth(event)}
            >
              {mode === 'register' && (
                <label className="block text-sm">
                  Display name
                  <input
                    className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-500"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    required
                    maxLength={100}
                    autoComplete="name"
                  />
                </label>
              )}
              <label className="block text-sm">
                Email
                <input
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-500"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                />
              </label>
              <label className="block text-sm">
                Password
                <input
                  className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-500"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={mode === 'register' ? 12 : 1}
                  autoComplete={
                    mode === 'register' ? 'new-password' : 'current-password'
                  }
                />
              </label>
              <button
                disabled={busy}
                className="w-full rounded-lg bg-cyan-500 px-4 py-2 font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
              >
                {busy
                  ? 'Please wait…'
                  : mode === 'login'
                    ? 'Sign in'
                    : 'Create account'}
              </button>
            </form>
            <button
              className="mt-6 text-sm text-cyan-400 hover:text-cyan-300"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setMessage('');
              }}
            >
              {mode === 'login'
                ? 'Need an account? Register'
                : 'Already registered? Sign in'}
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

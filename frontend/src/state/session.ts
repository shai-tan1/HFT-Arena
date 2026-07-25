import { create } from 'zustand';
import { api, getToken, setToken, type PublicUser } from '@/lib/api';
import { socket, type SocketStatus } from '@/lib/socket';

interface SessionState {
  user: PublicUser | null;
  status: SocketStatus;
  booting: boolean;
  error: string | null;

  boot: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  register: (handle: string, email: string, password: string) => Promise<void>;
  playAsGuest: (handle?: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  status: 'closed',
  booting: true,
  error: null,

  /**
   * Restore the stored token if it is still good, otherwise stay logged out.
   *
   * The landing page is the front door now: a visitor with no session lands
   * there and chooses login, sign up, or guest. We no longer mint a guest
   * automatically on boot — that would skip the door entirely. Guest access is
   * still one click away on the auth screen, so the low-friction path the game
   * was built around survives; it is just no longer the silent default.
   */
  async boot() {
    socket.onStatus((status) => set({ status }));
    try {
      if (getToken()) {
        const { user } = await api.me();
        set({ user, booting: false });
        socket.connect(getToken(), user.handle);
        return;
      }
    } catch {
      setToken(null);
    }
    set({ user: null, booting: false });
  },

  async login(identifier, password) {
    const { token, user } = await api.login(identifier, password);
    setToken(token);
    set({ user, error: null });
    socket.disconnect();
    socket.connect(token, user.handle);
  },

  async register(handle, email, password) {
    const { token, user } = await api.register(handle, email, password);
    setToken(token);
    set({ user, error: null });
    socket.disconnect();
    socket.connect(token, user.handle);
  },

  async playAsGuest(handle) {
    const { token, user } = await api.guest(handle);
    setToken(token);
    set({ user, error: null });
    socket.disconnect();
    socket.connect(token, user.handle);
  },

  logout() {
    setToken(null);
    set({ user: null });
    socket.disconnect();
    void get().boot();
  },

  async refresh() {
    try {
      const { user } = await api.me();
      set({ user });
    } catch {
      /* a stale profile is not worth surfacing an error for */
    }
  },
}));

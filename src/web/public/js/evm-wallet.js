// Which wallet signs: the browser's own (MetaMask, Coinbase Wallet, Rabby…) or a Base Account, a passkey wallet
// with no extension (Coinbase's @base-org/account SDK, loaded only when chosen). Both are EIP-1193 providers.
const BASE_ACCOUNT_SDK = {
  src: 'https://cdn.jsdelivr.net/npm/@base-org/account@2.6.0/dist/base-account.min.js',
  // The published file's hash (checked against the npm tarball, Nov 2026): the browser refuses any other file.
  integrity: 'sha384-DNBwtXm4do92aT9ti14+PEDNkrikClcyGA7x7UolT2UoB0+wSKTqs6jBSH837C9H',
};
let baseProvider = null;

function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => reject(new Error('couldn’t load the Base Account SDK'));
    document.head.appendChild(s);
  });
}

/** The wallets this browser can use, for a picker. */
export function walletChoices() {
  return [
    ...(window.ethereum ? [{ id: 'browser', name: 'Your browser wallet', note: 'MetaMask, Coinbase Wallet or another installed wallet' }] : []),
    { id: 'passkey', name: 'Base Account (passkey)', note: 'No extension: sign in with a passkey. Made by Coinbase.' },
  ];
}

/** An EIP-1193 provider for the chosen wallet. */
export async function walletProvider(id) {
  if (id === 'browser') { if (!window.ethereum) throw new Error('no wallet is installed in this browser'); return window.ethereum; }
  if (id === 'passkey') {
    if (baseProvider) return baseProvider;
    if (!window.base?.createBaseAccountSDK) await loadScript(BASE_ACCOUNT_SDK);
    baseProvider = window.base.createBaseAccountSDK({ appName: 'Constellate', appChainIds: [8453] }).getProvider();
    return baseProvider;
  }
  throw new Error('choose a wallet');
}

export const SDK_FOR_TESTS = BASE_ACCOUNT_SDK;

class Constellate < Formula
  desc "Shared memory, skills and problem solving for humans and agents on x0x"
  homepage "https://github.com/nkoteskey/constellate"
  # Filled in after the npm release (stop point: publishing needs approval).
  url "https://registry.npmjs.org/constellate-mcp/-/constellate-mcp-0.1.0.tgz"
  sha256 "REPLACE_AFTER_NPM_RELEASE"
  license any_of: ["MIT", "Apache-2.0"]

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "constellate", shell_output("#{bin}/constellate 2>&1")
  end
end

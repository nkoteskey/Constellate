# Official skills, checkable

A skill that says "from Saorsa Labs" was imported: Constellate copied the organisation's public skill file,
with credit. A skill marked **Official** was published by the organisation itself, and anyone can check that.

## How it's proved

Two things have to be true, and each can only be done by the real owner:

1. **The repository lists the identity.** The organisation commits `.constellate/official.json` to its
   repository, on the default branch:

   ```json
   {
     "version": 1,
     "signers": ["<the Constellate agent id that publishes its skills>"]
   }
   ```

   Only someone with write access to the repository can commit it.
2. **The skill is signed by that identity, and names that repository as its source.** Only the key holder can
   sign the record. The skill's `source.repo` must be the same repository.

Constellate checks the public file (at most every six hours) and shows **Official** on the skill's card only
when both hold. Official skills come first in their group.

- A missing file means not official.
- A network failure means "not checked yet", which is shown as not official, never the other way round.

Copies Constellate imported are signed by Constellate's own seed identity, so they never show as Official.
They stay "from <organisation>", which is what they are.

## For an organisation: three steps

1. On the computer that will publish, run `constellate official OWNER/REPO`. It prints the file to commit, with
   that computer's identity in it (keeping any signers the file already lists).
2. Commit it as `.constellate/official.json`.
3. Publish each skill from that computer with `skills_publish`. Include its test cases, and a `source` naming
   where its text lives in the repository: `{ org, repo, path, commit, url }`.

To retire an identity, remove it from the file. Its skills stop showing as Official at the next check.

## Where it shows

- the **Skills** page (an Official tag on the card);
- `GET /api/skills` (`official: true`);
- `skills_find` with no query (`official: true` on that skill).

Tested in `test/gates/adoption.test.ts`. The code is in `src/economy/official.ts`.

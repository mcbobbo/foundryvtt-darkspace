import { default as PlayerSD } from "/systems/shadowdark/src/models/PlayerSD.mjs";

// Shared base for all Darkspace actors (Spacer, Ship).
export default class ActorBaseDS extends PlayerSD {

    /**
     * Set or adjust credits from user input. A "+" or "-" prefix adjusts
     * relative to the current total; a plain number sets it outright.
     * Credits never go below the schema minimum (zero for spacers, but
     * ships may go into debt). Invalid input is ignored.
     * @param {string|number} input
     */
    async adjustCredits(input) {
        const currentCredits = this.coins.gp;
        const inputValue = String(input).trim();

        let newCredits;
        if (inputValue.startsWith("+")) {
            newCredits = currentCredits + parseInt(inputValue.slice(1), 10);
        } else if (inputValue.startsWith("-")) {
            newCredits = currentCredits - parseInt(inputValue.slice(1), 10);
        } else {
            newCredits = parseInt(inputValue, 10);
        }

        if (isNaN(newCredits)) return;
        const min = this.schema.getField("coins.gp")?.min ?? -Infinity;
        return this.parent.update({ "system.coins.gp": Math.max(min, newCredits) });
    }

    /**
     * Compatibility wrapper: Shadowdark v4 renamed rollStatCheck to rollAbilityCheck.
     */
    async rollStatCheck(abilityId, config={}) {
        if (typeof super.rollAbilityCheck === "function") {
            return super.rollAbilityCheck(abilityId, config);
        }
        if (typeof super.rollStatCheck === "function") {
            return super.rollStatCheck(abilityId, config);
        }
        return false;
    }
}

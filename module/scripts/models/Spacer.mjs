import ActorBaseDS from "./ActorBaseDS.mjs";

export default class Spacer extends ActorBaseDS {
    static defineSchema() {
        const fields = foundry.data.fields;
        const schema = {
            motivation:    new fields.StringField({ initial: "" }),
            shipUuid:      new fields.StringField({ initial: "" }),
            shipRoleUuids: new fields.ArrayField(new fields.StringField({ initial: "" })),
            bounty:        new fields.NumberField({ required: true, integer: true, initial: 0, min: 0 }),
            corruption:    new fields.NumberField({ required: true, integer: true, initial: 0, min: 0 }),
            player:        new fields.StringField({ initial: "" }),
        };
        return Object.assign(super.defineSchema(), schema);
    }

    /**
     * CredChits occupy 1 gear slot per 100 after the first 100 free, unless
     * the spacer carries a CredStick (which stores digital credits at 0 slots).
     * @override
     */
    getSlotUsage() {
        const slots = super.getSlotUsage();
        const hasCredStick = this.getPhysicalItems().some(
            i => i.name?.toLowerCase().includes("credstick")
        );
        if (hasCredStick && slots.coins > 0) {
            slots.total -= slots.coins;
            slots.coins = 0;
        }
        return slots;
    }

    /**
     * Transfers credits from this spacer to their assigned ship.
     * The transfer is capped at the spacer's current credits.
     * @param {number} credits - amount to transfer
     */
    async creditsToShip(credits) {
        const amount = Math.min(Math.floor(credits), this.coins.gp);
        if (!(amount > 0)) return;

        const ship = await fromUuid(this.shipUuid).catch(() => null);
        if (!ship) {
            return ui.notifications.warn(game.i18n.localize("DARKSPACE.sheet.spacer.credits.noShip"));
        }

        await ship.update({ "system.coins.gp": ship.system.coins.gp + amount });
        return this.parent.update({ "system.coins.gp": this.coins.gp - amount });
    }

    // -----------------------------------------------
    // Function Overrides
    // -----------------------------------------------

    async getAncestry() {
        return this.parent.items.find(i => i.type === "Ancestry") ?? null;
    }

    async getClass() {
        return this.parent.items.find(i => i.type === "Class") ?? null;
    }

    async getBackground() {
        return this.parent.items.find(i => i.type === "Background") ?? null;
    }

    async addAncestry(item) {
        const talents = item.system.talents ?? [];
        const fixed = talents.length <= item.system.talentChoiceCount ? talents : [];
        return this.#replaceEmbeddedIdentity(item, "ancestry", fixed);
    }

    async addClass(item) {
        return this.#replaceEmbeddedIdentity(item, "class", item.system.talents ?? []);
    }

    async addBackground(item) {
        return this.#replaceEmbeddedIdentity(item);
    }

    // -----------------------------------------------
    // Private Functions
    // -----------------------------------------------

    async #replaceEmbeddedIdentity(item, talentClass, talentUuids=[]) {
        const oldIds = this.parent.items
            .filter(i => i.type === item.type
                || (talentClass && i.type === "Talent" && i.system.talentClass === talentClass))
            .map(i => i.id);

        const newItems = [item.toObject()];
        for (const uuid of talentUuids) {
            const talent = await fromUuid(uuid);
            if (!talent) continue;
            const talentObj = await shadowdark.effects.createItemWithEffect(talent);
            if (!talentObj) continue;
            talentObj.system.talentClass = talentClass;
            newItems.push(talentObj);
        }

        if (oldIds.length) await this.parent.deleteEmbeddedDocuments("Item", oldIds);
        return this.parent.createEmbeddedDocuments("Item", newItems);
    }
}

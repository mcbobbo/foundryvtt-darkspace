import ActorBaseDS from "./ActorBaseDS.mjs";

const fields = foundry.data.fields;

// coins.gp > credits
// class > shipClass
// slots > Cargo
export default class Ship extends ActorBaseDS {

    static defineSchema() {
        return {
            ...super.defineSchema(),
            // Ships can run a negative credit balance to represent debt,
            // so gp has no minimum unlike the Shadowdark base schema.
            coins: new fields.SchemaField({
                gp: new fields.NumberField({ integer: true, initial: 0 }),
                sp: new fields.NumberField({ integer: true, initial: 0, min: 0 }),
                cp: new fields.NumberField({ integer: true, initial: 0, min: 0 }),
            }),
        };
    }

    // Crew is derived: a spacer belongs to this ship when its shipUuid points here.
    getCrew() {
        return game.actors.filter(a =>
            a.type === "darkspace.Spacer" && a.system.shipUuid === this.parent.uuid);
    }

    /**
     * Transfers credits from this ship, split evenly among its crew.
     * @param {number} credits - amount to transfer
     */
    async creditsToCrew(credits) {
        const amount = Math.floor(credits);
        if (!(amount > 0)) return;

        const crew = this.getCrew();
        if (!crew.length) {
            return ui.notifications.warn(game.i18n.localize("DARKSPACE.sheet.ship.credits.noCrew"));
        }

        const share = Math.floor(amount / crew.length);
        if (!share) return;

        for (const spacer of crew) {
            await spacer.update({ "system.coins.gp": spacer.system.coins.gp + share });
        }
        return this.parent.update({ "system.coins.gp": this.coins.gp - share * crew.length });
    }

    getCrewLevel() {
        const crew = this.getCrew();
        if (!crew.length) return 0;
        const total = crew.reduce((sum, a) => sum + (a.system?.level?.value ?? 0), 0);
        return Math.floor(total / crew.length);
    }

    /**
     * The ship's class item. Prefers the linked uuid, falling back to whichever
     * class item is embedded on the ship.
     * @returns {Promise<Item|null>}
     */
    async getShipClass() {
        const linked = this.class ? await fromUuid(this.class).catch(() => null) : null;
        return linked ?? this.parent.items.find(i => i.type === "darkspace.ShipClass") ?? null;
    }

    get needsLevelUp() {
        return this.getCrewLevel() > (this.level?.value ?? 0);
    }

    prepareBaseData() {
        super.prepareBaseData();

        // Both cargo values are calculated: the capacity is granted by
        // active effects, the load is the sum of the cargo aboard.
        this.cargo = {
            max: 0,
            value: 0,
        };
    }

    prepareDerivedData() {
        super.prepareDerivedData();

        const dexMod = this.abilities?.dex?.mod ?? 0;
        const acBonusKey = this._getActiveEffectKeys("attributes.ac.value", 0);
        const aeBonus = Number(acBonusKey?.value ?? 0) || 0;

        // Base ship AC is 10 + Ship DEX mod (+ any Active Effect AC bonuses)
        let baseProjectile = 10 + dexMod;
        let baseEnergy = 10 + dexMod;
        let bonusProjectile = aeBonus;
        let bonusEnergy = aeBonus;

        for (const item of this.parent?.items ?? []) {
            if (item.type === "darkspace.ShipArmor") {
                const p = item.system.acProjectile ?? 0;
                const e = item.system.acEnergy ?? 0;
                const isHeavy = item.name?.toLowerCase().includes("heavy");

                if (p >= 10) {
                    const effP = isHeavy ? p : p + dexMod;
                    if (effP > baseProjectile) baseProjectile = effP;
                } else {
                    bonusProjectile += isHeavy ? (p - dexMod) : p;
                }

                if (e >= 10) {
                    const effE = isHeavy ? e : e + dexMod;
                    if (effE > baseEnergy) baseEnergy = effE;
                } else {
                    bonusEnergy += (isHeavy && p > 0) ? (e - dexMod) : e;
                }
            }
        }
        this.attributes.ac.projectile = baseProjectile + bonusProjectile;
        this.attributes.ac.energy = baseEnergy + bonusEnergy;

        // Space Hauler talent adds positive STR mod to cargo capacity
        const hasSpaceHauler = (this.parent?.items ?? []).some(
            i => i.type === "Talent" && i.name?.toLowerCase().includes("space hauler")
        );
        if (hasSpaceHauler && (this.abilities?.str?.mod ?? 0) > 0) {
            this.cargo.max += this.abilities.str.mod;
        }

        this.cargo.value = this._getCargoValue();
    }

    get isPC() {
        return false;
    }

    /**
     * The cargo aboard the ship.
     * @returns {Item[]}
     */
    getCargoItems() {
        return (this.parent?.items ?? []).filter(i => i.type === "darkspace.Cargo");
    }

    _getCargoValue() {
        return this.getCargoItems().reduce((sum, i) => sum + (i.system.units ?? 1), 0);
    }

    /**
     * Builds the list of crew member options and their modifier for the given ability.
     * @param {string} ability
     * @returns {Array<object>}
     */
    _getCrewCheckChoices(ability) {
        const assignedCrew = this.getCrew();
        const crewActors = assignedCrew.length
            ? assignedCrew
            : game.actors.filter(a => a.type === "darkspace.Spacer");
        const shipRoles = (this.parent?.items ?? []).filter(i => i.type === "darkspace.ShipRole");
        const abilityShort = ability.toUpperCase();

        return crewActors.map(spacer => {
            const baseMod = spacer.system?.abilities?.[ability]?.mod ?? 0;
            let mod = baseMod;
            if (typeof spacer.system?._getActiveEffectKeys === "function") {
                const rk = spacer.system._getActiveEffectKeys(`roll.stat.bonus.${ability}`, baseMod);
                const parsed = Number(rk?.value);
                if (!Number.isNaN(parsed)) mod = parsed;
            }
            const signMod = mod >= 0 ? `+${mod}` : `${mod}`;
            const formattedBonus = mod === 0
                ? " + 0"
                : shadowdark.dice.formatBonus(mod);

            const roleNames = shipRoles
                .filter(r => (spacer.system?.shipRoleUuids ?? []).includes(r.uuid))
                .map(r => r.name);
            const roleSuffix = roleNames.length ? ` [${roleNames.join(", ")}]` : "";
            const label = `${spacer.name}${roleSuffix} (${abilityShort} ${signMod})`;
            const tooltip = shadowdark.dice.createToolTip(spacer.name, mod);

            return {
                uuid: spacer.uuid,
                name: spacer.name,
                mod,
                signMod,
                formattedBonus,
                label,
                tooltip,
            };
        });
    }

    /**
     * @override
     * Generates the stat check config for the Ship and appends the selected
     * crew member's stat modifier to the roll formula and tooltips.
     */
    _generateStatCheckConfig(config) {
        if (typeof super._generateStatCheckConfig === "function") {
            super._generateStatCheckConfig(config);
        }
        const ability = config?.check?.stat;
        if (!ability || !config?.mainRoll) return;

        config.crewChoices = this._getCrewCheckChoices(ability);

        const selectedCrew = config.crewMemberUuid
            ? config.crewChoices.find(c => c.uuid === config.crewMemberUuid)
            : null;

        if (selectedCrew) {
            config.mainRoll.formula = `${config.mainRoll.formula}${selectedCrew.formattedBonus}`;
            config.mainRoll.tooltips = [config.mainRoll.tooltips, selectedCrew.tooltip]
                .filter(Boolean)
                .join(", ");
            config.mainRoll.label = `${game.i18n.localize("SHADOWDARK.roll.check")} (${selectedCrew.name})`;
        }
    }

    /** @override */
    async rollStatCheck(abilityId, config={}) {
        if (this.rollConfigGenerators) {
            this.rollConfigGenerators.check = this._generateStatCheckConfig.bind(this);
        }
        return super.rollStatCheck(abilityId, config);
    }

    /**
     * Injects the Crew Member dropdown into Shadowdark's RollDialogSD when
     * rolling a stat check on a Ship.
     * @param {ApplicationV2} dialog
     */
    static injectCrewSelect(dialog) {
        if (!dialog?.config?.crewChoices || !dialog.element) return;
        if (dialog.element.querySelector(".ds-crew-check-row")) return;

        const row = document.createElement("div");
        row.classList.add("roll-input", "flexrow", "ds-crew-check-row");

        const label = document.createElement("label");
        label.textContent = game.i18n.localize("DARKSPACE.dialog.ship_check.crew_member");
        row.appendChild(label);

        const select = document.createElement("select");
        select.name = "crewMemberUuid";
        select.classList.add("ds-crew-check-select");
        select.style.flex = "1";

        const noneOpt = document.createElement("option");
        noneOpt.value = "";
        noneOpt.textContent = game.i18n.localize("DARKSPACE.dialog.ship_check.no_crew");
        select.appendChild(noneOpt);

        for (const c of dialog.config.crewChoices) {
            const opt = document.createElement("option");
            opt.value = c.uuid;
            opt.textContent = c.label;
            if (dialog.config.crewMemberUuid === c.uuid) {
                opt.selected = true;
            }
            select.appendChild(opt);
        }

        const hint = document.createElement("p");
        hint.classList.add("tooltips");
        hint.textContent = game.i18n.localize("DARKSPACE.dialog.ship_check.crew_hint");

        row.appendChild(select);
        row.appendChild(hint);

        const firstRollInput = dialog.element.querySelector(".roll-input");
        if (firstRollInput) {
            firstRollInput.before(row);
        }

        select.addEventListener("change", async event => {
            const formData = new foundry.applications.ux.FormDataExtended(dialog.element).object;
            const currentAdvantage = formData.advantage !== undefined
                ? parseInt(formData.advantage, 10)
                : undefined;
            const currentRollMode = formData.rollMode;

            dialog.config.crewMemberUuid = event.currentTarget.value;

            const actor = (dialog.config.actorUuid ? await fromUuid(dialog.config.actorUuid) : null)
                ?? game.actors.get(dialog.config.actorId);
            await actor?.system?.rollConfigGenerators?.[dialog.config.type]?.(dialog.config);

            if (currentAdvantage !== undefined && !Number.isNaN(currentAdvantage) && dialog.config.mainRoll) {
                dialog.config.mainRoll.advantage = currentAdvantage;
            }
            if (currentRollMode !== undefined) {
                dialog.config.rollMode = currentRollMode;
            }

            await dialog.render(true);
        });
    }
}

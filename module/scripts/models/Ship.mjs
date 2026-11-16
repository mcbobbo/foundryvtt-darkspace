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
     * Updates the roll dialog's formula input and hint live when the crew member
     * dropdown selection changes.
     * @param {HTMLSelectElement} selectEl
     */
    static onCrewCheckChange(selectEl) {
        const form = selectEl?.closest("form");
        if (!form) return;

        const opt = selectEl.selectedOptions?.[0];
        const baseFormula = selectEl.dataset.baseFormula || "d20";
        const formattedMod = opt?.dataset?.formattedMod || "";

        const formulaInput = form.querySelector('input[name="mainRoll.formula"]');
        if (formulaInput) {
            formulaInput.value = `${baseFormula}${formattedMod}`;

            const formGroup = formulaInput.closest(".form-group");
            if (formGroup) {
                const baseTooltips = selectEl.dataset.baseTooltips || "";
                const crewTooltip = opt?.dataset?.tooltipEntry || "";
                const combinedHint = [baseTooltips, crewTooltip].filter(Boolean).join(", ");

                let hintEl = formGroup.querySelector(".hint");
                if (!hintEl && combinedHint) {
                    hintEl = document.createElement("p");
                    hintEl.classList.add("hint");
                    formGroup.appendChild(hintEl);
                }
                if (hintEl) {
                    hintEl.textContent = combinedHint;
                }
            }
        }

        const appliedInput = form.querySelector('input[name="crewModApplied"]');
        if (appliedInput) {
            appliedInput.value = "1";
        }
    }

    /**
     * Ship stat checks prompt for which crew member is performing the check
     * and add their corresponding ability modifier to the final formula.
     * @override
     */
    async rollAbilityCheck(abilityId, config={}) {
        const ability = abilityId?.toLowerCase();
        if (!CONFIG.SHADOWDARK.ABILITY_KEYS.includes(ability)) return false;

        config.type = "ability-check";
        config.actorId = this.parent.id;
        config.ability = ability;
        config.title ??= game.i18n.localize("SHADOWDARK.dialog.ability_check.title");
        config.heading ??= game.i18n.localize(`SHADOWDARK.dialog.ability_check.${ability}`);

        this._generateAbilityCheckConfig(ability, config);
        const shipBaseFormula = config.mainRoll.formula;
        const shipBaseTooltips = config.mainRoll.tooltips ?? "";

        // Crew members assigned to this ship; fallback to all Spacers if none assigned
        const assignedCrew = this.getCrew();
        const crewActors = assignedCrew.length
            ? assignedCrew
            : game.actors.filter(a => a.type === "darkspace.Spacer");
        const shipRoles = (this.parent?.items ?? []).filter(i => i.type === "darkspace.ShipRole");
        const abilityShort = ability.toUpperCase();

        const crewChoices = crewActors.map(spacer => {
            const baseMod = spacer.system?.abilities?.[ability]?.mod ?? 0;
            const rollKey = typeof spacer.system?._getActiveEffectKeys === "function"
                ? spacer.system._getActiveEffectKeys(`roll.${ability}.bonus`, baseMod)
                : { value: baseMod };
            const parsedMod = Number(rollKey?.value);
            const mod = Number.isNaN(parsedMod) ? baseMod : parsedMod;
            const signMod = mod >= 0 ? `+${mod}` : `${mod}`;
            const formattedMod = ` ${signMod}`;

            const roleNames = shipRoles
                .filter(r => (spacer.system?.shipRoleUuids ?? []).includes(r.uuid))
                .map(r => r.name);
            const roleSuffix = roleNames.length ? ` [${roleNames.join(", ")}]` : "";
            const optionLabel = `${spacer.name}${roleSuffix} (${abilityShort} ${signMod})`;
            const tooltipEntry = `${spacer.name} (${signMod})`;

            return {
                uuid: spacer.uuid,
                name: spacer.name,
                mod,
                signMod,
                formattedMod,
                optionLabel,
                tooltipEntry,
            };
        });

        // Build Crew Member dropdown form group for the roll dialog
        config.mainFormGroups ??= [];
        const crewFormGroup = document.createElement("div");
        crewFormGroup.classList.add("form-group");

        const crewLabel = document.createElement("label");
        crewLabel.textContent = game.i18n.localize("DARKSPACE.dialog.ship_check.crew_member");
        crewFormGroup.appendChild(crewLabel);

        const crewFields = document.createElement("div");
        crewFields.classList.add("form-fields");

        const crewSelect = document.createElement("select");
        crewSelect.name = "crewMemberUuid";
        crewSelect.classList.add("ds-crew-check-select");
        crewSelect.dataset.baseFormula = shipBaseFormula;
        crewSelect.dataset.baseTooltips = shipBaseTooltips;
        crewSelect.setAttribute("onchange", "globalThis.darkspace?.onShipCrewCheckChange?.(this)");

        const noneOpt = document.createElement("option");
        noneOpt.value = "";
        noneOpt.textContent = game.i18n.localize("DARKSPACE.dialog.ship_check.no_crew");
        noneOpt.dataset.mod = "0";
        noneOpt.dataset.formattedMod = "";
        noneOpt.dataset.tooltipEntry = "";
        crewSelect.appendChild(noneOpt);

        for (const c of crewChoices) {
            const opt = document.createElement("option");
            opt.value = c.uuid;
            opt.textContent = c.optionLabel;
            opt.dataset.mod = String(c.mod);
            opt.dataset.formattedMod = c.formattedMod;
            opt.dataset.crewName = c.name;
            opt.dataset.tooltipEntry = c.tooltipEntry;
            if (config.crewMemberUuid && config.crewMemberUuid === c.uuid) {
                opt.selected = true;
            }
            crewSelect.appendChild(opt);
        }

        const appliedInput = document.createElement("input");
        appliedInput.type = "hidden";
        appliedInput.name = "crewModApplied";
        appliedInput.value = "0";

        const preselectedCrew = config.crewMemberUuid
            ? crewChoices.find(c => c.uuid === config.crewMemberUuid)
            : null;
        if (preselectedCrew) {
            config.mainRoll.formula = `${shipBaseFormula}${preselectedCrew.formattedMod}`;
            config.mainRoll.tooltips = [shipBaseTooltips, preselectedCrew.tooltipEntry].filter(Boolean).join(", ");
            appliedInput.value = "1";
        }

        crewFields.appendChild(crewSelect);
        crewFields.appendChild(appliedInput);
        crewFormGroup.appendChild(crewFields);

        const crewHint = document.createElement("p");
        crewHint.classList.add("hint");
        crewHint.textContent = game.i18n.localize("DARKSPACE.dialog.ship_check.crew_hint");
        crewFormGroup.appendChild(crewHint);

        config.mainFormGroups.push(crewFormGroup);

        // Show roll prompt and end if closed
        const prompt = await shadowdark.dice.rollDialog(config);
        if (!prompt) return false;

        // Recompute ship base check config in case situational AE checkboxes were toggled
        const postShipConfig = { selected: config.selected };
        this._generateAbilityCheckConfig(ability, postShipConfig);
        const updatedShipFormula = postShipConfig.mainRoll.formula;
        const updatedShipTooltips = postShipConfig.mainRoll.tooltips ?? "";

        const selectedCrew = config.crewMemberUuid
            ? crewChoices.find(c => c.uuid === config.crewMemberUuid)
            : null;

        if (selectedCrew) {
            if (String(config.crewModApplied) !== "1") {
                config.mainRoll.formula = `${config.mainRoll.formula}${selectedCrew.formattedMod}`;
            } else if (updatedShipFormula !== shipBaseFormula) {
                config.mainRoll.formula = `${updatedShipFormula}${selectedCrew.formattedMod}`;
            }
            config.mainRoll.tooltips = [updatedShipTooltips, selectedCrew.tooltipEntry]
                .filter(Boolean)
                .join(", ");
            config.mainRoll.label = `${game.i18n.localize("SHADOWDARK.dialog.roll")} (${selectedCrew.name})`;
            config.heading = `${config.heading} — ${selectedCrew.name}`;
        } else {
            if (updatedShipFormula !== shipBaseFormula && config.mainRoll.formula === shipBaseFormula) {
                config.mainRoll.formula = updatedShipFormula;
            }
            config.mainRoll.tooltips = updatedShipTooltips;
        }

        // Call Stat Check hooks and cancel if any return false
        if (!await Hooks.call("SD-Stat-Check", config)) return false;

        // Evaluate and roll the check
        return await shadowdark.dice.rollFromConfig(config);
    }
}

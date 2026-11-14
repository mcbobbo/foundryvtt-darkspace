import { default as CharacterGeneratorSD } from "/systems/shadowdark/src/apps/CharacterGeneratorSD.mjs";

// DarkSpace character generator. Reuses the Shadowdark generator's loading,
// randomization and logic. Outputs a darkspace.Spacer actor.
export default class CharacterGeneratorDS extends CharacterGeneratorSD {

    LEVEL_ZERO_GEAR_TABLE_UUID = "Compendium.darkspace.rollable-tables.RollTable.dsStartingGear00";

    constructor(actorUid=null) {
        super(actorUid);

        this.formData.actor.type = "darkspace.Spacer";
        this.formData.actor.system.motivation = "";

        this.formData.motivations = [
            { value: "survivor", label: "DARKSPACE.motivation.survivor" },
            { value: "vile",     label: "DARKSPACE.motivation.vile" },
            { value: "virtuous", label: "DARKSPACE.motivation.virtuous" },
        ];
    }


    /** @inheritdoc */
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ["darkspace", "shadowdark", "character-generator"],
        });
    }


    /** @inheritdoc */
    get template() {
        return "modules/darkspace/templates/apps/character-generator.hbs";
    }


    /** @inheritdoc */
    get title() {
        return game.i18n.localize("DARKSPACE.apps.character-generator.title");
    }


    /** @override */
    async getData(options) {
        const firstrun = this.firstrun;
        const formData = await super.getData(options);

        // Spacers embed their species as an item instead of linking a uuid,
        // so the base class's editing setup loaded nothing. Map the embedded
        // species back to its compendium entry and load its talents/languages.
        if (firstrun && formData.editing) {
            const species = await game.actors.get(this.actorUid).system.getAncestry();
            if (species) {
                const compendiumMatch = formData.ancestries.find(a => a.name === species.name);
                formData.actor.system.ancestry = compendiumMatch?.uuid ?? species.uuid;
                await this._loadAncestry(formData.actor.system.ancestry, true);
            }
        }

        return formData;
    }


    /** @override */
    _getRandomizationTasks(eventStr) {
        const randomizationTasks = {
            "randomize-ancestry": false,
            "randomize-background": false,
            "randomize-class": false,
            "randomize-gear": false,
            "randomize-gold": false,
            "randomize-motivation": false,
            "randomize-name": false,
            "randomize-stats": false,
        };

        if (eventStr === "randomize-all") {
            Object.keys(randomizationTasks).forEach(
                key => randomizationTasks[key] = true
            );
        }
        else {
            randomizationTasks[eventStr] = true;
        }

        return randomizationTasks;
    }


    /** @override */
    async _randomizeHandler(event) {
        const randomizationTasks = this._getRandomizationTasks(event.target.name);

        if (randomizationTasks["randomize-ancestry"]) await this._randomizeAncestry();
        if (randomizationTasks["randomize-background"]) this._randomizeBackground();
        if (randomizationTasks["randomize-class"]) await this._randomizeClass();
        if (randomizationTasks["randomize-motivation"]) await this._randomizeMotivation();
        if (randomizationTasks["randomize-gear"]) await this._randomizeGear();
        if (randomizationTasks["randomize-gold"]) await this._randomizeGold();
        if (randomizationTasks["randomize-name"]) await this._randomizeName();
        if (randomizationTasks["randomize-stats"]) await this._randomizeStats();

        shadowdark.utils.diceSound();

        this.render();
    }


    /** @override No species items may exist yet; skip rather than crash. */
    async _randomizeAncestry() {
        if (this.formData.ancestries.size === 0) return;
        return super._randomizeAncestry();
    }


    async _randomizeMotivation() {
        const tempInt = this._getRandom(this.formData.motivations.length);
        this.formData.actor.system.motivation = this.formData.motivations[tempInt].value;
    }


    /**
     * @override
     * 0-Level Citizens roll 1d4 items from the Citizen Starting Gear table
     * (plus 1 extra item if their Motivation is The Survivor).
     */
    async _randomizeGear() {
        const table = await fromUuid(this.LEVEL_ZERO_GEAR_TABLE_UUID);
        if (!table) return;

        try {
            let numItems = await this._roll("1d4");
            if (this.formData.actor.system.motivation === "survivor") {
                numItems += 1;
            }
            const results = [];
            for (let i = 0; i < numItems; i++) {
                const draw = await table.draw({ displayChat: false });
                results.push(...draw.results);
            }
            this.formData.gearSelected = (
                await shadowdark.utils.getItemsFromRollResults(results)
            ).sort((a, b) => a.name.localeCompare(b.name));
        }
        catch (error) {
            shadowdark.error(error);
        }
    }


    /**
     * @override
     * 1st-Level Rookies start with 2d6 x 10 credits (plus 2d10 extra credits
     * if their Motivation is The Vile).
     */
    async _randomizeGold() {
        let startingCredits = (await this._roll("2d6")) * 10;
        if (this.formData.actor.system.motivation === "vile") {
            startingCredits += await this._roll("2d10");
        }
        this.formData.actor.system.coins.gp = startingCredits;
    }


    // -----------------------------------------------
    // Actor creation / update
    // -----------------------------------------------

    /**
     * @override
     */
    async _createCharacter() {

        const allItems = [];

        // load talents with selection of options, tagged for sheet grouping
        const talentGroups = [
            { talentClass: "ancestry", talents: [
                ...this.formData.ancestryTalents.fixed,
                ...this.formData.ancestryTalents.selection,
            ]},
            { talentClass: "class", talents: [
                ...this.formData.classTalents.fixed,
                ...this.formData.classTalents.selection,
            ]},
        ];

        for (const group of talentGroups) {
            for (const talentItem of group.talents) {
                const talentObj = await shadowdark.effects.createItemWithEffect(talentItem);
                if (!talentObj) continue;
                talentObj.system.talentClass = group.talentClass;
                allItems.push(talentObj);
            }
        }

        // add class abilities
        for (const classAbilityItem of this.formData.classAbilities) {
            allItems.push(await fromUuid(classAbilityItem.uuid));
        }

        // add starting spells
        for (const spellItem of this.formData.startingSpells) {
            allItems.push(await fromUuid(spellItem.uuid));
        }

        // Check for Name
        if (this.formData.actor.name === "") {
            ui.notifications.error(game.i18n.localize("SHADOWDARK.apps.character-generator.error.name"));
            return;
        }

        // level 0 characters get rolled gear instead of credits
        if (this.formData.level0) {
            this.formData.actor.system.coins.gp = (this.formData.actor.system.motivation === "vile")
                ? await this._roll("2d10")
                : 0;

            for (const item of this.formData.gearSelected) {
                const doc = await fromUuid(item.uuid);
                if (!doc) continue;
                const obj = doc.toObject();
                // Citizen Starting Gear result #6 grants Energy Cells (2)
                if (obj.name === "Energy Cell") {
                    obj.system.quantity = 2;
                }
                allItems.push(obj);
            }
        }

        // Species, archetype and background are embedded items on a Spacer
        const identityUuids = [
            this.formData.actor.system.ancestry,
            this.formData.actor.system.class,
            this.formData.actor.system.background,
        ];
        for (const uuid of identityUuids) {
            const identityItem = uuid ? await fromUuid(uuid) : null;
            if (identityItem) allItems.push(identityItem.toObject());
        }
        this.formData.actor.system.ancestry = "";
        this.formData.actor.system.class = "";
        this.formData.actor.system.background = "";

        // Set level and calculate initial HP based on level
        if (this.formData.level0) {
            this.formData.actor.system.level = { value: 0, xp: 0 };
            let hpConMod = this.formData.actor.system.abilities.con.mod;
            if (hpConMod < 1) hpConMod = 1;
            this.formData.actor.system.attributes.hp.max = hpConMod;
            this.formData.actor.system.attributes.hp.value = hpConMod;
            this.formData.actor.system.attributes.hp.base = hpConMod;
        } else {
            this.formData.actor.system.level = { value: 1, xp: 0 };
            const hitDie = this.formData.classHP || "1d6";
            const hpRoll = await this._roll(hitDie);
            let hpTotal = hpRoll + this.formData.actor.system.abilities.con.mod;
            if (hpTotal < 1) hpTotal = 1;
            this.formData.actor.system.attributes.hp.max = hpTotal;
            this.formData.actor.system.attributes.hp.value = hpTotal;
            this.formData.actor.system.attributes.hp.base = hpTotal;
        }

        // Create the new spacer
        if (shadowdark.utils.canCreateCharacter()) {
            CharacterGeneratorDS.createActorFromData(
                this.formData.actor,
                allItems,
                game.userId,
                this.formData.level0
            );
        }
        else {
            game.socket.emit("system.shadowdark", {
                type: "createCharacter",
                payload: {
                    characterData: this.formData.actor,
                    characterItems: allItems,
                    userId: game.userId,
                    level0: this.formData.level0,
                },
            });
        }

        this.close();
    }


    /**
     * @override
     */
    async _updateCharacter() {
        const actorRef = game.actors.get(this.actorUid);

        // replaces any previous archetype and its "class" tagged talents,
        // and embeds the new archetype's fixed talents already tagged
        const archetypeItem = await fromUuid(this.formData.actor.system.class);
        if (!archetypeItem) return;
        await actorRef.system.addClass(archetypeItem);

        // set languages and starting credits
        await actorRef.update({
            system: {
                languages: this.formData.actor.system.languages,
                coins: {gp: this.formData.actor.system.coins.gp},
            } });

        actorRef.setFlag("shadowdark", "showLevelUp", true);

        // chosen talents, class abilities and starting spells
        const allItems = [];
        for (const talentItem of this.formData.classTalents.selection) {
            const talentObj = await shadowdark.effects.createItemWithEffect(talentItem);
            if (!talentObj) continue;
            talentObj.system.talentClass = "class";
            allItems.push(talentObj);
        }
        for (const classAbilityItem of this.formData.classAbilities) {
            allItems.push(await fromUuid(classAbilityItem.uuid));
        }
        for (const spellItem of this.formData.startingSpells) {
            allItems.push(await fromUuid(spellItem.uuid));
        }

        if (allItems.length) {
            await actorRef.createEmbeddedDocuments("Item", allItems);
        }

        // open actor sheet
        actorRef.sheet.render(true);
        this.close();
    }
}

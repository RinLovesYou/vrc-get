"use client"

import {
	Button,
	ButtonGroup,
	Card,
	Checkbox,
	Dialog,
	DialogBody,
	DialogFooter,
	DialogHeader,
	IconButton,
	List,
	ListItem,
	Menu,
	MenuHandler,
	MenuItem,
	MenuList,
	Spinner,
	Tooltip,
	Typography
} from "@material-tailwind/react";
import React, {Fragment, Suspense, useMemo, useState} from "react";
import {ArrowLeftIcon, ArrowPathIcon, ChevronDownIcon, EllipsisHorizontalIcon,} from "@heroicons/react/24/solid";
import {ArrowUpCircleIcon, MinusCircleIcon, PlusCircleIcon,} from "@heroicons/react/24/outline";
import {HNavBar, VStack} from "@/components/layout";
import {useRouter, useSearchParams} from "next/navigation";
import {SearchBox} from "@/components/SearchBox";
import {useQueries} from "@tanstack/react-query";
import {
	environmentCopyProjectForMigration,
	environmentHideRepository,
	environmentPackages,
	environmentRepositoriesInfo,
	environmentSetHideLocalUserPackages,
	environmentShowRepository,
	projectApplyPendingChanges,
	projectBeforeMigrateProjectTo2022,
	projectDetails,
	projectFinalizeMigrationWithUnity2022,
	projectInstallPackage,
	projectMigrateProjectTo2022,
	projectRemovePackage,
	projectResolve,
	projectUpgradeMultiplePackage,
	TauriBasePackageInfo,
	TauriPackage,
	TauriPendingProjectChanges,
	TauriProjectDetails,
	TauriUserRepository,
	TauriVersion,
	utilOpen
} from "@/lib/bindings";
import {compareUnityVersion, compareVersion, toVersionString} from "@/lib/version";
import {VGOption, VGSelect} from "@/components/select";
import {unsupported} from "@/lib/unsupported";
import {openUnity} from "@/lib/open-unity";
import {nop} from "@/lib/nop";
import {shellOpen} from "@/lib/shellOpen";
import {receiveLinesAndWaitForFinish} from "@/lib/migration-with-2022";
import {Trans, useTranslation} from "react-i18next";
import {toastError, toastSuccess, toastThrownError} from "@/lib/toast";

export default function Page(props: {}) {
	return <Suspense><PageBody {...props}/></Suspense>
}

type RequestedOperation = {
	type: "install";
	pkg: TauriPackage;
} | {
	type: "upgradeAll";
} | {
	type: "remove";
	pkgId: string;
}

type InstallStatus = {
	status: "normal";
} | {
	status: "creatingChanges";
} | {
	status: "promptingChanges";
	changes: TauriPendingProjectChanges;
	requested: RequestedOperation;
} | {
	status: "applyingChanges";
} | {
	status: "unity2022migration:confirm";
} | {
	status: "unity2022migration:confirmUnityVersionMismatch";
	recommendedUnityVersion: string;
	foundUnityVersion: string;
	inPlace: boolean;
} | {
	status: "unity2022migration:copyingProject";
} | {
	status: "unity2022migration:updating";
} | {
	status: "unity2022migration:finalizing";
	lines: [number, string][];
}

function PageBody() {
	const {t} = useTranslation();
	const searchParams = useSearchParams();
	const router = useRouter();

	const projectPath = searchParams.get("projectPath") ?? "";
	const projectName = nameFromPath(projectPath);

	function nameFromPath(path: string): string {
		let indexOfSlash = path.lastIndexOf("/");
		let indexOfBackSlash = path.lastIndexOf("\\");
		let indexOfSeparator = Math.max(indexOfSlash, indexOfBackSlash);
		if (indexOfSeparator == -1) return path;
		return path.substring(indexOfSeparator + 1);
	}

	const [repositoriesInfo, packagesResult, detailsResult] = useQueries({
		queries: [
			{
				queryKey: ["environmentRepositoriesInfo"],
				queryFn: environmentRepositoriesInfo,
			},
			{
				queryKey: ["environmentPackages"],
				queryFn: environmentPackages,
			},
			{
				queryKey: ["projectDetails", projectPath],
				queryFn: () => projectDetails(projectPath),
			},
		]
	});

	const [installStatus, setInstallStatus] = useState<InstallStatus>({status: "normal"});
	const [search, setSearch] = useState("");

	const packageRowsData = useMemo(() => {
		const packages = packagesResult.status == 'success' ? packagesResult.data : [];
		const details = detailsResult.status == 'success' ? detailsResult.data : null;
		const hiddenRepositories = repositoriesInfo.status == 'success' ? repositoriesInfo.data.hidden_user_repositories : [];
		const hideUserPackages = repositoriesInfo.status == 'success' ? repositoriesInfo.data.hide_local_user_packages : false;
		const definedRepositories = repositoriesInfo.status == 'success' ? repositoriesInfo.data.user_repositories : [];
		const showPrereleasePackages = repositoriesInfo.status == 'success' ? repositoriesInfo.data.show_prerelease_packages : false;
		return combinePackagesAndProjectDetails(packages, details, hiddenRepositories, hideUserPackages, definedRepositories, showPrereleasePackages);
	}, [repositoriesInfo, packagesResult, detailsResult]);

	const packageRows = useMemo(() => {
		if (search === "") return packageRowsData;
		const searchLower = search.toLowerCase();
		return packageRowsData.filter(row =>
			row.displayName.toLowerCase().includes(searchLower)
			|| row.id.toLowerCase().includes(searchLower)
			|| row.aliases.some(alias => alias.toLowerCase().includes(searchLower)))
	}, [packageRowsData, search]);

	const hiddenUserRepositories = useMemo(() => new Set(repositoriesInfo.status == 'success' ? repositoriesInfo.data.hidden_user_repositories : []), [repositoriesInfo]);

	const TABLE_HEAD = [
		"package",
		"installed",
		"latest",
		"source",
		"", // actions
	];

	// TODO: get installed unity versions and show them
	const unityVersions: string[] = []

	const onRefresh = () => {
		packagesResult.refetch();
		detailsResult.refetch();
		repositoriesInfo.refetch();
	};

	const onInstallRequested = async (pkg: TauriPackage) => {
		try {
			setInstallStatus({status: "creatingChanges"});
			console.log("install", pkg.name, pkg.version);
			const changes = await projectInstallPackage(projectPath, pkg.env_version, pkg.index);
			setInstallStatus({status: "promptingChanges", changes, requested: {type: "install", pkg}});
		} catch (e) {
			console.error(e);
			setInstallStatus({status: "normal"});
			toastThrownError(e);
		}
	}

	const onUpgradeAllRequest = async () => {
		try {
			setInstallStatus({status: "creatingChanges"});
			let packages: number[] = [];
			let envVersion: number | undefined = undefined;
			for (let packageRow of packageRows) {
				if (packageRow.latest.status === "upgradable") {
					if (envVersion == null) envVersion = packageRow.latest.pkg.env_version;
					else if (envVersion != packageRow.latest.pkg.env_version) throw new Error("Inconsistent env_version");
					packages.push(packageRow.latest.pkg.index);
				}
			}
			if (envVersion == null) {
				toastError(t("no upgradable packages"));
				return;
			}
			const changes = await projectUpgradeMultiplePackage(projectPath, envVersion, packages);
			setInstallStatus({status: "promptingChanges", changes, requested: {type: "upgradeAll"}});
		} catch (e) {
			console.error(e);
			setInstallStatus({status: "normal"});
			toastThrownError(e);
		}
	}

	const onResolveRequest = async () => {
		try {
			setInstallStatus({status: "creatingChanges"});
			const changes = await projectResolve(projectPath);
			setInstallStatus({status: "promptingChanges", changes, requested: {type: "upgradeAll"}});
		} catch (e) {
			console.error(e);
			setInstallStatus({status: "normal"});
			toastThrownError(e);
		}
	};

	const onRemoveRequested = async (pkgId: string) => {
		try {
			setInstallStatus({status: "creatingChanges"});
			console.log("remove", pkgId);
			const changes = await projectRemovePackage(projectPath, pkgId);
			setInstallStatus({status: "promptingChanges", changes, requested: {type: "remove", pkgId}});
		} catch (e) {
			console.error(e);
			setInstallStatus({status: "normal"});
			toastThrownError(e);
		}
	}

	const applyChanges = async (
		{
			changes,
			requested,
		}: {
			changes: TauriPendingProjectChanges,
			requested: RequestedOperation,
		}) => {
		try {
			setInstallStatus({status: "applyingChanges"});
			await projectApplyPendingChanges(projectPath, changes.changes_version);
			setInstallStatus({status: "normal"});
			detailsResult.refetch();

			switch (requested.type) {
				case "install":
					toastSuccess(t("installed {{name}} version {{version}}",
						{name: requested.pkg.display_name ?? requested.pkg.name, version: toVersionString(requested.pkg.version)}));
					break;
				case "remove":
					toastSuccess(t("removed {{name}}", {name: requested.pkgId}));
					break;
				case "upgradeAll":
					toastSuccess(t("upgraded all packages"));
					break;
				default:
					let _: never = requested;
			}
		} catch (e) {
			console.error(e);
			setInstallStatus({status: "normal"});
			toastThrownError(e);
		}
	}

	const requestMigrateProjectTo2022 = async () => {
		setInstallStatus({status: "unity2022migration:confirm"});
	}

	const cancelMigrateProjectTo2022 = async () => {
		setInstallStatus({status: "normal"});
	}

	const doMigrateProjectTo2022 = async (allowMismatch: boolean, inPlace: boolean) => {
		try {
			const preMigrationResult = await projectBeforeMigrateProjectTo2022(allowMismatch);
			switch (preMigrationResult.type) {
				case "NoUnity2022Found":
					toastError(t("failed to migrate project: unity 2022 not found"));
					setInstallStatus({status: "normal"});
					return;
				case "ConfirmNotExactlyRecommendedUnity2022":
					setInstallStatus({
						status: "unity2022migration:confirmUnityVersionMismatch",
						recommendedUnityVersion: preMigrationResult.recommended,
						foundUnityVersion: preMigrationResult.found,
						inPlace,
					});
					return; // do rest after confirm
				case "ReadyToMigrate":
					break;
				default:
					const _: never = preMigrationResult;
			}
			let migrateProjectPath;
			if (inPlace) {
				migrateProjectPath = projectPath;
			} else {
				// copy
				setInstallStatus({status: "unity2022migration:copyingProject"});
				migrateProjectPath = await environmentCopyProjectForMigration(projectPath);
			}
			setInstallStatus({status: "unity2022migration:updating"});
			await projectMigrateProjectTo2022(migrateProjectPath);
			setInstallStatus({status: "unity2022migration:finalizing", lines: []});
			const finalizeResult = await projectFinalizeMigrationWithUnity2022(migrateProjectPath);
			switch (finalizeResult.type) {
				case "NoUnity2022Found":
					toastError(t("failed to finalize the migration: unity 2022 not found"));
					break;
				case "MigrationStarted":
					let lineNumber = 0;
					await receiveLinesAndWaitForFinish(finalizeResult.event_name, lineString => {
						setInstallStatus(prev => {
							if (prev.status != "unity2022migration:finalizing") return prev;
							lineNumber++;
							let line: [number, string] = [lineNumber, lineString];
							if (prev.lines.length > 200) {
								return {...prev, lines: [...prev.lines.slice(1), line]};
							} else {
								return {...prev, lines: [...prev.lines, line]};
							}
						})
					});
					toastSuccess(t("the project is migrated to unity 2022"));
					break;
				default:
					const _: never = finalizeResult;
			}
			if (inPlace) {
				setInstallStatus({status: "normal"});
				detailsResult.refetch();
			} else {
				setInstallStatus({status: "normal"});
				router.replace(`/projects/manage?${new URLSearchParams({projectPath: migrateProjectPath})}`);
			}
		} catch (e) {
			console.error(e);
			toastThrownError(e);
			setInstallStatus({status: "normal"});
		}
	};

	const installingPackage = installStatus.status != "normal";
	const isLoading = packagesResult.isFetching || detailsResult.isFetching || repositoriesInfo.isFetching || installingPackage;

	function checkIfMigrationTo2022Recommended(data: TauriProjectDetails) {
		if (data.unity == null) return false;
		// migrate if the project is using 2019 and has vrcsdk
		if (data.unity[0] != 2019) return false;
		return data.installed_packages.some(([id, _]) => VRCSDK_PACKAGES.includes(id));
	}

	const isMigrationTo2022Recommended = detailsResult.status == 'success' && checkIfMigrationTo2022Recommended(detailsResult.data);

	let dialogForState: React.ReactNode = null;

	switch (installStatus.status) {
		case "promptingChanges":
			dialogForState = <ProjectChangesDialog
				packages={packageRowsData}
				changes={installStatus.changes}
				cancel={() => setInstallStatus({status: "normal"})}
				apply={() => applyChanges(installStatus)}
			/>;
			break;
		case "unity2022migration:confirm":
			dialogForState = <Unity2022MigrationConfirmMigrationDialog
				cancel={cancelMigrateProjectTo2022}
				doMigrate={(inPlace) => doMigrateProjectTo2022(false, inPlace)}
			/>;
			break;
		case "unity2022migration:confirmUnityVersionMismatch":
			dialogForState = <Unity2022MigrationUnityVersionMismatchDialog
				recommendedUnityVersion={installStatus.recommendedUnityVersion}
				foundUnityVersion={installStatus.foundUnityVersion}
				cancel={cancelMigrateProjectTo2022}
				doMigrate={() => doMigrateProjectTo2022(true, installStatus.inPlace)}
			/>;
			break;
		case "unity2022migration:copyingProject":
			dialogForState = <Unity2022MigrationCopyingDialog/>;
		case "unity2022migration:updating":
			dialogForState = <Unity2022MigrationMigratingDialog/>;
			break;
		case "unity2022migration:finalizing":
			dialogForState = <Unity2022MigrationCallingUnityForMigrationDialog lines={installStatus.lines}/>;
			break;
	}

	return (
		<VStack className={"m-4"}>
			<ProjectViewHeader className={"flex-shrink-0"} projectName={projectName} projectPath={projectPath}/>
			<Card className={"flex-shrink-0 p-2 flex flex-row"}>
				<Typography className="cursor-pointer py-1.5 font-bold flex-grow-0 flex-shrink overflow-hidden">
					<Trans
						t={t}
						i18nKey={"located at: <code>{{path}}</code>"}
						components={{code: <code className={"bg-gray-200 p-0.5 whitespace-pre"}/>}}
						values={{path: projectPath}}/>
				</Typography>
				<div className={"flex-grow flex-shrink-0 w-2"}></div>
				<Typography className="cursor-pointer py-1.5 font-bold flex-grow-0 flex-shrink-0">
					{t("unity version: ")}
				</Typography>
				<div className={"flex-grow-0 flex-shrink-0"}>
					<VGSelect value={detailsResult.status == 'success' ? detailsResult.data.unity_str :
						<span className={"text-blue-gray-300"}>Loading...</span>}
										className="border-blue-gray-200">
						{unityVersions.map(v => <VGOption key={v} value={v}>{v}</VGOption>)}
					</VGSelect>
				</div>
			</Card>
			{isMigrationTo2022Recommended &&
				<SuggestMigrateTo2022Card disabled={isLoading} onMigrateRequested={requestMigrateProjectTo2022}/>}
			<main className="flex-shrink overflow-hidden flex">
				<Card className="w-full p-2 gap-2 flex-grow flex-shrink flex">
					<div className={"flex flex-shrink-0 flex-grow-0 flex-row gap-2"}>
						<Typography className="cursor-pointer py-1.5 font-bold flex-grow-0 flex-shrink-0">
							{t("manage packages")}
						</Typography>

						<Tooltip content="Reflesh Packages">
							<IconButton variant={"text"} onClick={onRefresh} className={"flex-shrink-0"} disabled={isLoading}>
								{isLoading ? <Spinner className="w-5 h-5"/> : <ArrowPathIcon className={"w-5 h-5"}/>}
							</IconButton>
						</Tooltip>

						<SearchBox className={"w-max flex-grow"} value={search} onChange={e => setSearch(e.target.value)}/>

						<Menu>
							<MenuHandler>
								<IconButton variant={"text"}>
									<EllipsisHorizontalIcon className={"size-5"}/>
								</IconButton>
							</MenuHandler>
							<MenuList>
								{packageRows.some(row => row.latest.status === "upgradable") &&
									<MenuItem className={"p-3 text-green-700 focus:text-green-700"}
														onClick={onUpgradeAllRequest}
														disabled={isLoading}>
										{t("upgrade all")}</MenuItem>}
								<MenuItem className={"p-3"}
													onClick={onResolveRequest}
													disabled={isLoading}>
									{t("reinstall all")}</MenuItem>
							</MenuList>
						</Menu>

						<Menu dismiss={{itemPress: false}}>
							<MenuHandler>
								<Button className={"flex-shrink-0 p-3"}>{t("select repositories")}</Button>
							</MenuHandler>
							<MenuList className={"max-h-96 w-64"}>
								<RepositoryMenuItem
									hiddenUserRepositories={hiddenUserRepositories}
									repositoryName={t("official")}
									repositoryId={"com.vrchat.repos.official"}
									refetch={() => repositoriesInfo.refetch()}
								/>
								<RepositoryMenuItem
									hiddenUserRepositories={hiddenUserRepositories}
									repositoryName={t("curated")}
									repositoryId={"com.vrchat.repos.curated"}
									refetch={() => repositoriesInfo.refetch()}
								/>
								<UserLocalRepositoryMenuItem
									hideUserLocalPackages={repositoriesInfo.status == 'success' ? repositoriesInfo.data.hide_local_user_packages : false}
									refetch={() => repositoriesInfo.refetch()}
								/>
								<hr className="my-3"/>
								{
									repositoriesInfo.status == 'success' ? repositoriesInfo.data.user_repositories.map(repository => (
										<RepositoryMenuItem
											hiddenUserRepositories={hiddenUserRepositories}
											repositoryName={repository.display_name}
											repositoryId={repository.id}
											refetch={() => repositoriesInfo.refetch()}
											key={repository.id}
										/>
									)) : null
								}
							</MenuList>
						</Menu>
					</div>
					<Card className="w-full overflow-x-auto overflow-y-scroll">
						<table className="relative table-auto text-left">
							<thead>
							<tr>
								{TABLE_HEAD.map((head, index) => (
									<th key={index}
											className={`sticky top-0 z-10 border-b border-blue-gray-100 bg-blue-gray-50 p-2.5`}>
										<Typography variant="small" className="font-normal leading-none">{t(head)}</Typography>
									</th>
								))}
							</tr>
							</thead>
							<tbody>
							{packageRows.map((row) => (
								<PackageRow pkg={row} key={row.id}
														locked={isLoading}
														onInstallRequested={onInstallRequested}
														onRemoveRequested={onRemoveRequested}/>
							))}
							</tbody>
						</table>
					</Card>
				</Card>
				{dialogForState}
			</main>
		</VStack>
	);
}

function SuggestMigrateTo2022Card(
	{
		disabled,
		onMigrateRequested,
	}: {
		disabled?: boolean;
		onMigrateRequested: () => void;
	}
) {
	const {t} = useTranslation();

	return (
		<Card className={"flex-shrink-0 p-2 flex flex-row"}>
			<Typography
				className="cursor-pointer py-1.5 font-bold flex-grow-0 flex-shrink overflow-hidden whitespace-normal text-sm">
				{t("unity 2019 to 2022 migration suggestion")}
			</Typography>
			<div className={"flex-grow flex-shrink-0 w-2"}></div>
			<Button variant={"text"} color={"red"} onClick={onMigrateRequested} disabled={disabled}>
				{t("migrate project")}
			</Button>
		</Card>
	)
}

function Unity2022MigrationConfirmMigrationDialog(
	{
		cancel,
		doMigrate,
	}: {
		cancel: () => void,
		doMigrate: (inPlace: boolean) => void,
	}) {
	const {t} = useTranslation();

	return (
		<Dialog open handler={nop} className={"whitespace-normal"}>
			<DialogHeader>{t("unity migration")}</DialogHeader>
			<DialogBody>
				<Typography className={"text-red-700"}>
					{t("project migration is experimental in vrc-get.")}
				</Typography>
				<Typography className={"text-red-700"}>
					{t("please make backup of your project before migration.")}
				</Typography>
			</DialogBody>
			<DialogFooter>
				<Button onClick={cancel} className="mr-1">{t("cance;")}</Button>
				<Button onClick={() => doMigrate(false)} color={"red"} className="mr-1">{t("migrate a copy")}</Button>
				<Button onClick={() => doMigrate(true)} color={"red"}>{t("migrate in-place")}</Button>
			</DialogFooter>
		</Dialog>
	);
}

function Unity2022MigrationUnityVersionMismatchDialog(
	{
		recommendedUnityVersion,
		foundUnityVersion,
		cancel,
		doMigrate,
	}: {
		recommendedUnityVersion: string,
		foundUnityVersion: string,
		cancel: () => void,
		doMigrate: () => void,
	}) {
	const {t} = useTranslation();

	return (
		<Dialog open handler={nop} className={"whitespace-normal"}>
			<DialogHeader>{t("unity migration")}</DialogHeader>
			<DialogBody>
				<Typography>
					{t("we could not find unity exact recommended version of unity 2022")}
				</Typography>
				<Typography>
					{t("recommended: {{version}}", {version: recommendedUnityVersion})}
				</Typography>
				<Typography>
					{t("found: {{version}}", {version: foundUnityVersion})}
				</Typography>
				<Typography>
					{t("this may cause problems with VRChat SDK")}
				</Typography>
				<Typography>
					{t("do you want to continue?")}
				</Typography>
			</DialogBody>
			<DialogFooter>
				<Button onClick={cancel} className="mr-1">{t("cancel")}</Button>
				<Button onClick={doMigrate} color={"red"}>{t("continue")}</Button>
			</DialogFooter>
		</Dialog>
	);
}

function Unity2022MigrationCopyingDialog() {
	const {t} = useTranslation();

	return (
		<Dialog open handler={nop} className={"whitespace-normal"}>
			<DialogHeader>{t("unity migration")}</DialogHeader>
			<DialogBody>
				<Typography>
					{t("copying project for migration...")}
				</Typography>
				<Typography>
					{t("please do not close the window")}
				</Typography>
			</DialogBody>
		</Dialog>
	);
}

function Unity2022MigrationMigratingDialog() {
	const {t} = useTranslation();

	return (
		<Dialog open handler={nop} className={"whitespace-normal"}>
			<DialogHeader>{t("unity migration")}</DialogHeader>
			<DialogBody>
				<Typography>
					{t("migrating project...")}
				</Typography>
				<Typography>
					{t("please do not close the window")}
				</Typography>
			</DialogBody>
		</Dialog>
	);
}

function Unity2022MigrationCallingUnityForMigrationDialog(
	{
		lines
	}: {
		lines: [number, string][]
	}
) {
	const {t} = useTranslation();
	const ref = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		ref.current?.scrollIntoView({behavior: "auto"});
	}, [lines]);

	return (
		<Dialog open handler={nop} className={"whitespace-normal"}>
			<DialogHeader>{t("unity migration")}</DialogHeader>
			<DialogBody>
				<Typography>
					{t("launching unity 2022 in background for finalizing the migration...")}
				</Typography>
				<Typography>
					{t("please do not close the window")}
				</Typography>
				<pre className={"overflow-y-auto h-[50vh] bg-gray-900 text-white text-sm"}>
					{lines.map(([lineNumber, line]) => <Fragment key={lineNumber}>{line}{"\n"}</Fragment>)}
					<div ref={ref}/>
				</pre>
			</DialogBody>
		</Dialog>
	);
}

function ProjectChangesDialog(
	{
		changes,
		packages,
		cancel,
		apply,
	}: {
		changes: TauriPendingProjectChanges,
		packages: PackageRowInfo[],
		cancel: () => void,
		apply: () => void,
	}) {
	const {t} = useTranslation();
	const versionConflicts = changes.conflicts.filter(([_, c]) => c.packages.length > 0);
	const unityConflicts = changes.conflicts.filter(([_, c]) => c.unity_conflict);

	const getPackageDisplayName = useMemo(() => {
		const packagesById = new Map(packages.map(p => [p.id, p]));
		return (pkgId: string) => packagesById.get(pkgId)?.displayName ?? pkgId;
	}, [packages]);

	return (
		<Dialog open handler={nop} className={"whitespace-normal"}>
			<DialogHeader>Apply Changes</DialogHeader>
			<DialogBody>
				<Typography className={"text-gray-900"}>
					{t("you're applying the following changes to the project")}
				</Typography>
				<List className={"overflow-y-auto max-h-[50vh]"}>
					{changes.package_changes.map(([pkgId, pkgChange]) => {
						if ('InstallNew' in pkgChange) {
							let changelogUrlTmp = pkgChange.InstallNew.changelog_url;
							if (changelogUrlTmp != null && !changelogUrlTmp.startsWith("http") && !changelogUrlTmp.startsWith("https"))
								changelogUrlTmp = null;
							const changelogUrl = changelogUrlTmp;
							return <ListItem key={pkgId}>
								<Trans
									t={t}
									i18nKey={"install {{name}} version {{version}}"}
									values={{
										name: pkgChange.InstallNew.display_name ?? pkgChange.InstallNew.name,
										version: toVersionString(pkgChange.InstallNew.version)
									}}
								/>
								{changelogUrl != null &&
									<Button className={"ml-1 px-2"} size={"sm"}
													onClick={() => shellOpen(changelogUrl)}>{t("see changelog")}</Button>}
							</ListItem>
						} else {
							switch (pkgChange.Remove) {
								case "Requested":
									return <ListItem key={pkgId}><Trans
										t={t}
										i18nKey={"remove {{name}} since you requested"}
										values={{name: getPackageDisplayName(pkgId)}}/>
									</ListItem>
								case "Legacy":
									return <ListItem key={pkgId}><Trans
										t={t}
										i18nKey={"remove {{name}} since it's a legacy package"}
										values={{name: getPackageDisplayName(pkgId)}}/>
									</ListItem>
								case "Unused":
									return <ListItem key={pkgId}><Trans
										t={t}
										i18nKey={"remove {{name}} since it's not used"}
										values={{name: getPackageDisplayName(pkgId)}}/>
									</ListItem>
							}
						}
					})}
				</List>
				{
					versionConflicts.length > 0 ? (
						<>
							<Typography className={"text-red-700"}>
								{t("there are version conflicts", {count: versionConflicts.length})}
							</Typography>
							<List>
								{versionConflicts.map(([pkgId, conflict]) => {
									return (
										<ListItem key={pkgId}>
											<Trans
												t={t}
												i18nKey={"{{pkg}} conflicts with {{other}}"}
												values={{
													pkg: getPackageDisplayName(pkgId),
													other: conflict.packages.map(p => getPackageDisplayName(p)).join(", ")
												}}
											/>
										</ListItem>
									);
								})}
							</List>
						</>
					) : null
				}
				{
					unityConflicts.length > 0 ? (
						<>
							<Typography className={"text-red-700"}>
								{t("there are unity version conflicts", {count: unityConflicts.length})}
							</Typography>
							<List>
								{unityConflicts.map(([pkgId, _]) => (
									<ListItem key={pkgId}>
										<Trans
											t={t}
											i18nKey={"{{pkg}} does not support your unity version"}
											values={{pkg: getPackageDisplayName(pkgId)}}
										/>
									</ListItem>
								))}
							</List>
						</>
					) : null
				}
				{
					changes.remove_legacy_files.length > 0 || changes.remove_legacy_folders.length > 0 ? (
						<>
							<Typography className={"text-red-700"}>
								{t("the following legacy files and folders will be removed")}
							</Typography>
							<List>
								{changes.remove_legacy_files.map(f => (
									<ListItem key={f}>
										{f}
									</ListItem>
								))}
								{changes.remove_legacy_folders.map(f => (
									<ListItem key={f}>
										{f}
									</ListItem>
								))}
							</List>
						</>
					) : null
				}
			</DialogBody>
			<DialogFooter>
				<Button onClick={cancel} className="mr-1">{t("cancel")}</Button>
				<Button onClick={apply} color={"red"}>{t("apply")}</Button>
			</DialogFooter>
		</Dialog>
	);
}

function RepositoryMenuItem(
	{
		hiddenUserRepositories,
		repositoryName,
		repositoryId,
		refetch,
	}: {
		hiddenUserRepositories: Set<string>,
		repositoryName: string,
		repositoryId: string,
		refetch: () => void,
	}
) {
	const selected = !hiddenUserRepositories.has(repositoryId);
	const onChange = () => {
		if (selected) {
			environmentHideRepository(repositoryId).then(refetch);
		} else {
			environmentShowRepository(repositoryId).then(refetch);
		}
	};

	return (
		<MenuItem className="p-0">
			<label className={"flex cursor-pointer items-center gap-2 p-2 whitespace-normal"}>
				<Checkbox ripple={false} containerProps={{className: "p-0 rounded-none"}}
									checked={selected}
									onChange={onChange}
									className="hover:before:content-none"/>
				{repositoryName}
			</label>
		</MenuItem>
	)
}

function UserLocalRepositoryMenuItem(
	{
		hideUserLocalPackages,
		refetch,
	}: {
		hideUserLocalPackages: boolean,
		refetch: () => void,
	}
) {
	const {t} = useTranslation();
	const selected = !hideUserLocalPackages;
	const onChange = () => {
		if (selected) {
			environmentSetHideLocalUserPackages(true).then(refetch);
		} else {
			environmentSetHideLocalUserPackages(false).then(refetch);
		}
	};

	return (
		<MenuItem className="p-0">
			<label className={"flex cursor-pointer items-center gap-2 p-2"}>
				<Checkbox ripple={false} containerProps={{className: "p-0 rounded-none"}}
									checked={selected}
									onChange={onChange}
									className="hover:before:content-none"/>
				{t("user local")}
			</label>
		</MenuItem>
	)
}

type PackageLatestInfo = { status: "none" } | { status: "contains", pkg: TauriPackage } | {
	status: "upgradable",
	pkg: TauriPackage
};

interface PackageRowInfo {
	id: string;
	infoSource: TauriVersion;
	displayName: string;
	aliases: string[];
	unityCompatible: Map<string, TauriPackage>;
	unityIncompatible: Map<string, TauriPackage>;
	sources: Set<string>;
	isThereSource: boolean; // this will be true even if all sources are hidden
	installed: null | {
		version: TauriVersion;
		yanked: boolean;
	};
	latest: PackageLatestInfo;
}

const VRCSDK_PACKAGES = [
	"com.vrchat.avatars",
	"com.vrchat.worlds",
	"com.vrchat.base"
];

function combinePackagesAndProjectDetails(
	packages: TauriPackage[],
	project: TauriProjectDetails | null,
	hiddenRepositories?: string[] | null,
	hideLocalUserPackages?: boolean,
	definedRepositories: TauriUserRepository[] = [],
	showPrereleasePackages: boolean = false,
): PackageRowInfo[] {
	const hiddenRepositoriesSet = new Set(hiddenRepositories ?? []);

	function isUnityCompatible(pkg: TauriPackage, unityVersion: [number, number] | null) {
		if (unityVersion == null) return true;
		if (pkg.unity == null) return true;

		// vrcsdk exceptions for unity version
		if (VRCSDK_PACKAGES.includes(pkg.name)) {
			if (pkg.version.major === 3 && pkg.version.minor <= 4) {
				return unityVersion[0] === 2019;
			}
		} else if (pkg.name === "com.vrchat.core.vpm-resolver") {
			if (pkg.version.major === 0 && pkg.version.minor === 1 && pkg.version.patch <= 26) {
				return unityVersion[0] === 2019;
			}
		}

		return compareUnityVersion(pkg.unity, unityVersion) <= 0;
	}

	const yankedVersions = new Set<`${string}:${string}`>();
	const knownPackages = new Set<string>();
	const packagesPerRepository = new Map<string, TauriPackage[]>();
	const userPackages: TauriPackage[] = [];

	for (const pkg of packages) {
		if (!showPrereleasePackages && pkg.version.pre) continue;

		if (pkg.is_yanked) {
			yankedVersions.add(`${pkg.name}:${toVersionString(pkg.version)}`);
			continue;
		}

		knownPackages.add(pkg.name);

		let packages: TauriPackage[]
		// check the repository is visible
		if (pkg.source === "LocalUser") {
			if (hideLocalUserPackages) continue
			packages = userPackages;
		} else if ('Remote' in pkg.source) {
			if (hiddenRepositoriesSet.has(pkg.source.Remote.id)) continue;

			packages = packagesPerRepository.get(pkg.source.Remote.id) ?? [];
			packagesPerRepository.set(pkg.source.Remote.id, packages);
		} else {
			let never: never = pkg.source;
			throw new Error("unreachable");
		}

		packages.push(pkg);

	}

	const packagesTable = new Map<string, PackageRowInfo>();

	const getRowInfo = (pkg: TauriBasePackageInfo): PackageRowInfo => {
		let packageRowInfo = packagesTable.get(pkg.name);
		if (packageRowInfo == null) {
			packagesTable.set(pkg.name, packageRowInfo = {
				id: pkg.name,
				displayName: pkg.display_name ?? pkg.name,
				aliases: pkg.aliases,
				infoSource: pkg.version,
				unityCompatible: new Map(),
				unityIncompatible: new Map(),
				sources: new Set(),
				isThereSource: false,
				installed: null,
				latest: {status: "none"},
			});
		}
		return packageRowInfo;
	};

	function addPackage(pkg: TauriPackage) {
		const packageRowInfo = getRowInfo(pkg);
		packageRowInfo.isThereSource = true;

		if (compareVersion(pkg.version, packageRowInfo.infoSource) > 0) {
			// use display name from the latest version
			packageRowInfo.infoSource = pkg.version;
			packageRowInfo.displayName = pkg.display_name ?? pkg.name;
			packageRowInfo.aliases = pkg.aliases;
		}

		if (project == null || isUnityCompatible(pkg, project.unity)) {
			packageRowInfo.unityCompatible.set(toVersionString(pkg.version), pkg);
		} else {
			packageRowInfo.unityIncompatible.set(toVersionString(pkg.version), pkg);
		}

		if (pkg.source === "LocalUser") {
			packageRowInfo.sources.add("User");
		} else if ('Remote' in pkg.source) {
			packageRowInfo.sources.add(pkg.source.Remote.display_name);
		}
	}

	// predefined repositories
	packagesPerRepository.get("com.vrchat.repos.official")?.forEach(addPackage);
	packagesPerRepository.get("com.vrchat.repos.curated")?.forEach(addPackage);
	userPackages.forEach(addPackage);
	packagesPerRepository.delete("com.vrchat.repos.official");
	packagesPerRepository.delete("com.vrchat.repos.curated");

	// for repositories
	for (let definedRepository of definedRepositories) {
		packagesPerRepository.get(definedRepository.id)?.forEach(addPackage);
		packagesPerRepository.delete(definedRepository.id);
	}

	// in case of repository is not defined
	for (let packages of packagesPerRepository.values()) {
		packages.forEach(addPackage);
	}

	// sort versions
	for (let value of packagesTable.values()) {
		value.unityCompatible = new Map([...value.unityCompatible].sort((a, b) => -compareVersion(a[1].version, b[1].version)));
		value.unityIncompatible = new Map([...value.unityIncompatible].sort((a, b) => -compareVersion(a[1].version, b[1].version)));
	}

	// set latest info
	for (let value of packagesTable.values()) {
		const latestPackage = value.unityCompatible.values().next().value;
		if (latestPackage) {
			value.latest = {status: "contains", pkg: latestPackage};
		}
	}

	// set installed info
	if (project) {
		for (const [_, pkg] of project.installed_packages) {
			const packageRowInfo = getRowInfo(pkg);

			// if installed, use the installed version to get the display name
			packageRowInfo.displayName = pkg.display_name ?? pkg.name;
			packageRowInfo.aliases = [...pkg.aliases, ...packageRowInfo.aliases];
			packageRowInfo.installed = {
				version: pkg.version,
				yanked: pkg.is_yanked || yankedVersions.has(`${pkg.name}:${toVersionString(pkg.version)}`),
			};
			packageRowInfo.isThereSource = knownPackages.has(pkg.name);

			// if we have the latest version, check if it's upgradable
			if (packageRowInfo.latest.status != "none") {
				const compare = compareVersion(pkg.version, packageRowInfo.latest.pkg.version);
				if (compare < 0) {
					packageRowInfo.latest = {status: "upgradable", pkg: packageRowInfo.latest.pkg};
				}
			}
		}
	}

	const isAvatarsSdkInstalled = packagesTable.get("com.vrchat.avatars")?.installed != null;
	const isWorldsSdkInstalled = packagesTable.get("com.vrchat.worlds")?.installed != null;
	if (isAvatarsSdkInstalled != isWorldsSdkInstalled) {
		// if either avatars or worlds sdk is installed, remove the packages for the other SDK.

		// collect dependant packages
		const dependantPackages = new Map<string, Set<string>>();
		for (let pkg of packagesTable.values()) {
			if (pkg.latest.status != "none") {
				for (const dependency of pkg.latest.pkg.vpm_dependencies) {
					if (!dependantPackages.has(dependency)) {
						dependantPackages.set(dependency, new Set());
					}
					dependantPackages.get(dependency)!.add(pkg.id);
				}
			}
		}

		const toRemove = new Set<string>();

		// remove the other SDK
		if (isAvatarsSdkInstalled) {
			toRemove.add("com.vrchat.worlds");
		} else if (isWorldsSdkInstalled) {
			toRemove.add("com.vrchat.avatars");
		}

		// update forAvatars and forWorlds recursively
		while (toRemove.size > 0) {
			const pkgId = [...toRemove].pop()!;
			toRemove.delete(pkgId);

			if (!packagesTable.delete(pkgId)) continue // already removed

			const dependants = dependantPackages.get(pkgId);
			if (dependants != null)
				for (const dependant of dependants)
					toRemove.add(dependant);
		}
	}

	const asArray = Array.from(packagesTable.values());

	// put installed first
	asArray.sort((a, b) => {
		if (a.installed && !b.installed) return -1;
		if (!a.installed && b.installed) return 1;
		return 0;
	});

	return asArray;
}

function PackageRow(
	{
		pkg,
		locked,
		onInstallRequested,
		onRemoveRequested,
	}: {
		pkg: PackageRowInfo;
		locked: boolean;
		onInstallRequested: (pkg: TauriPackage) => void;
		onRemoveRequested: (pkgId: string) => void;
	}) {
	const {t} = useTranslation();

	const cellClass = "p-2.5";
	const noGrowCellClass = `${cellClass} w-1`;
	const versionNames = [...pkg.unityCompatible.keys()];
	const incompatibleNames = [...pkg.unityIncompatible.keys()];
	const latestVersion: string | undefined = versionNames[0];

	const onChange = (version: string) => {
		if (pkg.installed != null && version === toVersionString(pkg.installed.version)) return;
		const pkgVersion = pkg.unityCompatible.get(version) ?? pkg.unityIncompatible.get(version);
		if (!pkgVersion) return;
		onInstallRequested(pkgVersion);
	}

	const installLatest = () => {
		if (!latestVersion) return;
		const latest = pkg.unityCompatible.get(latestVersion) ?? pkg.unityIncompatible.get(latestVersion);
		if (!latest) return;
		onInstallRequested(latest);
	}

	const remove = () => {
		onRemoveRequested(pkg.id);
	};

	return (
		<tr className="even:bg-blue-gray-50/50">
			<td className={`${cellClass} overflow-hidden max-w-80 overflow-ellipsis`}>
				<div className="flex flex-col">
					<Typography className="font-normal">
						{pkg.displayName}
					</Typography>
					<Typography className="font-normal opacity-50 text-sm">
						{pkg.id}
					</Typography>
				</div>
			</td>
			<td className={noGrowCellClass}>
				{/* TODO: show incompatible versions */}
				<VGSelect value={<PackageInstalledInfo pkg={pkg}/>}
									className={`border-blue-gray-200 ${pkg.installed?.yanked ? "text-red-700" : ""}`}
									onChange={onChange}
									disabled={locked}
				>
					{versionNames.map(v => <VGOption key={v} value={v}>{v}</VGOption>)}
					{(incompatibleNames.length > 0 && versionNames.length > 0) && <hr className="my-2"/>}
					{incompatibleNames.length > 0 && <Typography className={"text-sm"}>{t("incompatibles")}</Typography>}
					{incompatibleNames.map(v => <VGOption key={v} value={v}>{v}</VGOption>)}
				</VGSelect>
			</td>
			<td className={`${cellClass} min-w-32 w-32`}>
				<PackageLatestInfo info={pkg.latest} locked={locked} onInstallRequested={onInstallRequested}/>
			</td>
			<td className={`${noGrowCellClass} max-w-32 overflow-hidden`}>
				{
					pkg.sources.size == 0 ? (
						pkg.isThereSource ? (
							<Typography className="font-normal text-blue-gray-400">
								{t("not selected")}
							</Typography>
						) : (
							<Typography className="font-normal text-blue-gray-400">
								{t("none")}
							</Typography>
						)
					) : pkg.sources.size == 1 ? (
						<Typography className="font-normal">
							{[...pkg.sources][0]}
						</Typography>
					) : (
						<Tooltip content={[...pkg.sources].join(", ")}>
							<Typography className="font-normal">
								{t("multiple sources")}
							</Typography>
						</Tooltip>
					)
				}
			</td>
			<td className={noGrowCellClass}>
				<div className="flex flex-row gap-2 max-w-min">
					{
						pkg.installed ? (
							<Tooltip content={"Remove Package"}>
								<IconButton variant={'text'} disabled={locked} onClick={remove}><MinusCircleIcon
									className={"size-5 text-red-700"}/></IconButton>
							</Tooltip>
						) : (
							<Tooltip content={"Add Package"}>
								<IconButton variant={'text'} disabled={locked && !!latestVersion}
														onClick={installLatest}><PlusCircleIcon
									className={"size-5 text-gray-800"}/></IconButton>
							</Tooltip>
						)
					}
				</div>
			</td>
		</tr>
	);
}

function PackageInstalledInfo(
	{
		pkg,
	}: {
		pkg: PackageRowInfo,
	}
) {
	const {t} = useTranslation();

	if (pkg.installed) {
		const version = toVersionString(pkg.installed.version);
		if (pkg.installed.yanked) {
			return <Typography className={"text-red-700"}>{version} {t("(yanked)")}</Typography>;
		} else {
			return <Typography>{version}</Typography>;
		}
	} else {
		return <Typography className="text-blue-gray-400">{t("none")}</Typography>;
	}
}

function PackageLatestInfo(
	{
		info,
		locked,
		onInstallRequested,
	}: {
		info: PackageLatestInfo,
		locked: boolean,
		onInstallRequested: (pkg: TauriPackage) => void;
	}
) {
	const {t} = useTranslation();

	switch (info.status) {
		case "none":
			return <Typography className="font-normal text-blue-gray-400">{t("none")}</Typography>;
		case "contains":
			return <Typography className="font-normal">{toVersionString(info.pkg.version)}</Typography>;
		case "upgradable":
			return (
				<Button variant={"outlined"} color={"green"}
								className={"text-left px-2 py-1 w-full h-full font-normal text-base normal-case"}
								disabled={locked}
								onClick={() => onInstallRequested(info.pkg)}>
					<ArrowUpCircleIcon color={"green"} className={"size-4 inline mr-2"}/>
					{toVersionString(info.pkg.version)}
				</Button>
			);
		default:
			let _: never = info;
	}
}

function ProjectViewHeader({className, projectName, projectPath}: {
	className?: string,
	projectName: string,
	projectPath: string
}) {
	const {t} = useTranslation();
	const openProjectFolder = () => utilOpen(projectPath);

	return (
		<HNavBar className={className}>
			<Tooltip content="Back to projects">
				<IconButton variant={"text"} onClick={() => history.back()}>
					<ArrowLeftIcon className={"w-5 h-5"}/>
				</IconButton>
			</Tooltip>

			<Typography className="cursor-pointer py-1.5 font-bold flex-grow-0 whitespace-pre">
				{projectName}
			</Typography>

			<div className="relative flex gap-2 w-max flex-grow">
			</div>

			<Menu>
				<ButtonGroup>
					<Button onClick={() => openUnity(projectPath)} className={"pl-4 pr-3"}>Open Unity</Button>
					<MenuHandler className={"pl-2 pr-2"}>
						<Button>
							<ChevronDownIcon className={"w-4 h-4"}/>
						</Button>
					</MenuHandler>
				</ButtonGroup>
				<MenuList>
					<MenuItem onClick={openProjectFolder}>{t("open project folder")}</MenuItem>
					<MenuItem onClick={unsupported("Backup")}>{t("make backup")}</MenuItem>
					<MenuItem onClick={unsupported("Remove")} className={"bg-red-700 text-white"}>{t("remove project")}</MenuItem>
				</MenuList>
			</Menu>
		</HNavBar>
	);
}
